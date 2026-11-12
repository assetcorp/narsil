import {
  BATCH_CHUNK_SIZE,
  ErrorCodes,
  loadEmbedCode,
  MAX_CALLS_ACROSS_INDEX_CHANGES,
  NarsilError,
  validateRequiredFields,
} from '#platform/optional-writes-host'
import type { AnyDocument } from '../../types/schema'
import type { WriteEmbedding } from '../embed'
import type { IndexHold } from '../index-hold'
import type { MutationContext } from './context'

type WriteEntry = ReturnType<MutationContext['requireIndex']>

export interface WritePreparation {
  document: AnyDocument
  beforeWrite: (() => void | Promise<void>) | null
  failure: unknown
}

function embedsThroughAdapter(entry: WriteEntry): boolean {
  return entry.config.embedding !== undefined && entry.embeddingAdapter !== null
}

function embeddingFits(entry: WriteEntry, embedding: WriteEmbedding | null): boolean {
  return embedsThroughAdapter(entry) ? embedding?.adapter === entry.embeddingAdapter : embedding === null
}

function writable(preparations: WritePreparation[]): WritePreparation[] {
  return preparations.filter(preparation => preparation.failure === undefined)
}

function failAll(preparations: WritePreparation[], failure: unknown): void {
  for (const preparation of writable(preparations)) preparation.failure = failure
}

function requireFieldsOf(entry: WriteEntry, preparations: WritePreparation[]): void {
  const required = entry.config.required
  if (required === undefined || required.length === 0) return
  for (const preparation of writable(preparations)) {
    try {
      validateRequiredFields(preparation.document as Record<string, unknown>, required)
    } catch (err) {
      preparation.failure = err
    }
  }
}

async function embedForWrite(
  ctx: MutationContext,
  indexName: string,
  preparations: WritePreparation[],
  earlier: WriteEmbedding | null,
  together: boolean,
): Promise<WriteEmbedding | null> {
  const entry = ctx.requireIndex(indexName)
  requireFieldsOf(entry, preparations)
  const { clearWriteEmbedding, embedDocumentsForWrite } = await loadEmbedCode()
  if (earlier !== null) clearWriteEmbedding(earlier)
  const embeddingConfig = entry.config.embedding
  const adapter = entry.embeddingAdapter
  const embeddable = writable(preparations)
  if (embeddingConfig === undefined || adapter === null || embeddable.length === 0) return null
  const fields: WriteEmbedding['fields'] = new Map()
  for (let chunkStart = 0; chunkStart < embeddable.length; chunkStart += BATCH_CHUNK_SIZE) {
    const chunk = embeddable.slice(chunkStart, chunkStart + BATCH_CHUNK_SIZE)
    const { embedding, failed } = await embedDocumentsForWrite(
      chunk.map(preparation => preparation.document as Record<string, unknown>),
      embeddingConfig,
      adapter,
      ctx.abortController.signal,
      together,
    )
    for (const [document, embedded] of embedding.fields) fields.set(document, embedded)
    for (const [position, error] of failed) chunk[position].failure = error
  }
  return { adapter, fields }
}

function runOutside<T>(hold: IndexHold | undefined, work: () => Promise<T>): Promise<T> {
  return hold === undefined ? work() : hold.outside(work)
}

async function runBeforeWrites(preparations: WritePreparation[]): Promise<void> {
  for (const preparation of preparations) {
    if (preparation.beforeWrite === null || preparation.failure !== undefined) continue
    try {
      await preparation.beforeWrite()
    } catch (err) {
      preparation.failure = err
    }
  }
}

function adapterChangesRefusal(indexName: string, embeddings: number): NarsilError {
  return new NarsilError(
    ErrorCodes.WORKER_BUSY,
    `Changes to index "${indexName}" replaced its embedding adapter after each of ${embeddings} embeddings of this write`,
    { indexName, embeddings },
  )
}

export async function prepareDocumentWrites(
  ctx: MutationContext,
  indexName: string,
  preparations: WritePreparation[],
  hold: IndexHold | undefined,
  together: boolean,
): Promise<WriteEntry> {
  let entry = ctx.requireIndex(indexName)
  if (writable(preparations).length === 0) return entry
  let embedding: WriteEmbedding | null = null
  let embeddings = 0
  const hooked = preparations.some(preparation => preparation.beforeWrite !== null)
  if (hooked || embedsThroughAdapter(entry)) {
    embedding = await runOutside(hold, async () => {
      await runBeforeWrites(preparations)
      return embedForWrite(ctx, indexName, preparations, null, together)
    })
    embeddings += 1
    entry = ctx.requireIndex(indexName)
  }
  while (writable(preparations).length > 0 && !embeddingFits(entry, embedding)) {
    if (embeddings >= MAX_CALLS_ACROSS_INDEX_CHANGES) {
      failAll(preparations, adapterChangesRefusal(indexName, embeddings))
      break
    }
    const earlier = embedding
    embedding = await runOutside(hold, () => embedForWrite(ctx, indexName, preparations, earlier, together))
    embeddings += 1
    entry = ctx.requireIndex(indexName)
  }
  requireFieldsOf(entry, preparations)
  const embeddingConfig = entry.config.embedding
  if (embeddingConfig !== undefined && entry.embeddingAdapter === null) {
    const { assertDocumentCarriesMappedVectors } = await loadEmbedCode()
    for (const preparation of writable(preparations)) {
      try {
        assertDocumentCarriesMappedVectors(
          preparation.document as Record<string, unknown>,
          embeddingConfig,
          entry.embeddingAdapterName,
        )
      } catch (err) {
        preparation.failure = err
      }
    }
  }
  return entry
}

export async function prepareDocumentWrite(
  ctx: MutationContext,
  indexName: string,
  document: AnyDocument,
  hold: IndexHold | undefined,
  beforeWrite: (() => void | Promise<void>) | null,
): Promise<WriteEntry> {
  const preparation: WritePreparation = { document, beforeWrite, failure: undefined }
  const entry = await prepareDocumentWrites(ctx, indexName, [preparation], hold, false)
  if (preparation.failure !== undefined) throw preparation.failure
  return entry
}
