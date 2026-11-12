import {
  BATCH_CHUNK_SIZE,
  ErrorCodes,
  loadEmbedCode,
  MAX_CALLS_ACROSS_INDEX_CHANGES,
  NarsilError,
  validateRequiredFields,
} from '#platform/optional-writes-host'
import type { EmbeddingAdapter } from '../../types/adapters'
import type { AnyDocument, EmbeddingFieldConfig } from '../../types/schema'
import type { WriteEmbedding } from '../embed'
import type { IndexHold } from '../index-hold'
import type { MutationContext } from './context'
import { runOutside } from './outside-hold'

type WriteEntry = ReturnType<MutationContext['requireIndex']>

export interface WritePreparation {
  document: AnyDocument
  beforeWrite: (() => void | Promise<void>) | null
  failure: unknown
}

export interface PreparedWrites {
  entry: WriteEntry
  embedding: WriteEmbedding | null
}

interface EmbeddingSettings {
  required: string[] | undefined
  embedding: EmbeddingFieldConfig | undefined
  adapter: EmbeddingAdapter | null
}

interface EmbeddingPass {
  embedding: WriteEmbedding | null
  called: boolean
  documentFailures: Map<WritePreparation, unknown>
}

function settingsOf(entry: WriteEntry): EmbeddingSettings {
  return { required: entry.config.required, embedding: entry.config.embedding, adapter: entry.embeddingAdapter }
}

function embedsThroughAdapter(entry: WriteEntry): boolean {
  return entry.config.embedding !== undefined && entry.embeddingAdapter !== null
}

function sourcesOf(sources: string | string[]): string[] {
  return typeof sources === 'string' ? [sources] : sources
}

function sameMapping(left: EmbeddingFieldConfig['fields'], right: EmbeddingFieldConfig['fields']): boolean {
  if (left === right) return true
  const targets = Object.keys(left)
  if (targets.length !== Object.keys(right).length) return false
  for (const target of targets) {
    if (!Object.hasOwn(right, target)) return false
    const leftSources = sourcesOf(left[target])
    const rightSources = sourcesOf(right[target])
    if (leftSources.length !== rightSources.length) return false
    if (leftSources.some((source, position) => source !== rightSources[position])) return false
  }
  return true
}

function embeddingFits(entry: WriteEntry, embedding: WriteEmbedding | null): boolean {
  const embeddingConfig = entry.config.embedding
  if (embeddingConfig === undefined || entry.embeddingAdapter === null) return embedding === null
  return (
    embedding !== null &&
    embedding.adapter === entry.embeddingAdapter &&
    sameMapping(embedding.mapping, embeddingConfig.fields)
  )
}

export function embeddingOfDocuments(
  embedding: WriteEmbedding | null,
  documents: AnyDocument[],
): WriteEmbedding | null {
  if (embedding === null) return null
  const fields: WriteEmbedding['fields'] = new Map()
  for (const document of documents) {
    const embedded = embedding.fields.get(document as Record<string, unknown>)
    if (embedded !== undefined) fields.set(document as Record<string, unknown>, embedded)
  }
  return { adapter: embedding.adapter, mapping: embedding.mapping, fields }
}

function writable(preparations: WritePreparation[]): WritePreparation[] {
  return preparations.filter(preparation => preparation.failure === undefined)
}

function failAll(preparations: WritePreparation[], failure: unknown): void {
  for (const preparation of writable(preparations)) preparation.failure = failure
}

function requireFieldsOf(required: string[] | undefined, preparations: WritePreparation[]): void {
  if (required === undefined || required.length === 0) return
  for (const preparation of writable(preparations)) {
    try {
      validateRequiredFields(preparation.document as Record<string, unknown>, required)
    } catch (err) {
      preparation.failure = err
    }
  }
}

async function requireMappedVectors(entry: WriteEntry, preparations: WritePreparation[]): Promise<void> {
  const embeddingConfig = entry.config.embedding
  if (embeddingConfig === undefined || entry.embeddingAdapter !== null) return
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

async function embedWith(
  settings: EmbeddingSettings,
  signal: AbortSignal,
  preparations: WritePreparation[],
  earlier: WriteEmbedding | null,
  together: boolean,
): Promise<EmbeddingPass> {
  requireFieldsOf(settings.required, preparations)
  const { clearWriteEmbedding, embedDocumentsForWrite, lacksMappedVectors } = await loadEmbedCode()
  if (earlier !== null) clearWriteEmbedding(earlier)
  const { embedding: embeddingConfig, adapter } = settings
  const embeddable = writable(preparations)
  const documentFailures = new Map<WritePreparation, unknown>()
  if (embeddingConfig === undefined || adapter === null || embeddable.length === 0) {
    return { embedding: null, called: false, documentFailures }
  }
  const fields: WriteEmbedding['fields'] = new Map()
  const embedding: WriteEmbedding = { adapter, mapping: embeddingConfig.fields, fields }
  const documents = embeddable.map(preparation => preparation.document as Record<string, unknown>)
  if (!lacksMappedVectors(documents, embeddingConfig)) return { embedding, called: false, documentFailures }
  for (let chunkStart = 0; chunkStart < embeddable.length; chunkStart += BATCH_CHUNK_SIZE) {
    const chunk = embeddable.slice(chunkStart, chunkStart + BATCH_CHUNK_SIZE)
    const embedded = await embedDocumentsForWrite(
      chunk.map(preparation => preparation.document as Record<string, unknown>),
      embeddingConfig,
      adapter,
      signal,
      together,
    )
    for (const [document, embeddedFields] of embedded.embedding.fields) fields.set(document, embeddedFields)
    for (const [position, error] of embedded.failed) chunk[position].failure = error
    for (const [position, error] of embedded.documentFailures) documentFailures.set(chunk[position], error)
  }
  return { embedding, called: true, documentFailures }
}

function settleDocumentFailures(entry: WriteEntry, pass: EmbeddingPass): WritePreparation[] {
  if (!embeddingFits(entry, pass.embedding)) return [...pass.documentFailures.keys()]
  for (const [preparation, failure] of pass.documentFailures) preparation.failure = failure
  return []
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

async function embedThenRunHooks(
  settings: EmbeddingSettings,
  signal: AbortSignal,
  preparations: WritePreparation[],
  earlier: WriteEmbedding | null,
): Promise<EmbeddingPass> {
  const pass = await embedWith(settings, signal, preparations, earlier, true)
  await runBeforeWrites(preparations.filter(preparation => !pass.documentFailures.has(preparation)))
  return pass
}

async function runHooksThenEmbedEach(
  ctx: MutationContext,
  indexName: string,
  preparations: WritePreparation[],
  earlier: WriteEmbedding | null,
): Promise<EmbeddingPass> {
  let settings: EmbeddingSettings | null = null
  let embedding: WriteEmbedding | null = null
  let called = false
  let uncleared = earlier
  const documentFailures = new Map<WritePreparation, unknown>()
  for (const preparation of preparations) {
    await runBeforeWrites([preparation])
    settings ??= settingsOf(ctx.requireIndex(indexName))
    const pass = await embedWith(settings, ctx.abortController.signal, [preparation], uncleared, false)
    uncleared = null
    called ||= pass.called
    for (const [failed, failure] of pass.documentFailures) documentFailures.set(failed, failure)
    if (pass.embedding === null) continue
    if (embedding === null) embedding = pass.embedding
    else for (const [document, fields] of pass.embedding.fields) embedding.fields.set(document, fields)
  }
  return { embedding, called, documentFailures }
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
  earlier: WriteEmbedding | null = null,
): Promise<PreparedWrites> {
  let entry = ctx.requireIndex(indexName)
  let embedding = earlier
  if (writable(preparations).length === 0) return { entry, embedding }
  const signal = ctx.abortController.signal
  let embeddings = 0
  let unhooked: WritePreparation[] = []
  const hooked = preparations.some(preparation => preparation.beforeWrite !== null)
  if (hooked || (embedsThroughAdapter(entry) && !embeddingFits(entry, embedding))) {
    if (together && !embedsThroughAdapter(entry)) {
      requireFieldsOf(entry.config.required, preparations)
      await requireMappedVectors(entry, preparations)
    }
    const settings = settingsOf(entry)
    const uncleared = embedding
    const pass = await runOutside(hold, () =>
      together
        ? embedThenRunHooks(settings, signal, preparations, uncleared)
        : runHooksThenEmbedEach(ctx, indexName, preparations, uncleared),
    )
    embedding = pass.embedding
    if (pass.called) embeddings += 1
    entry = ctx.requireIndex(indexName)
    unhooked = settleDocumentFailures(entry, pass)
  }
  while (writable(preparations).length > 0 && !embeddingFits(entry, embedding)) {
    if (embeddings >= MAX_CALLS_ACROSS_INDEX_CHANGES) {
      failAll(preparations, adapterChangesRefusal(indexName, embeddings))
      break
    }
    const uncleared = embedding
    const settings = settingsOf(entry)
    const hooking = unhooked
    const pass = await runOutside(hold, async () => {
      const embedded = await embedWith(settings, signal, preparations, uncleared, together)
      await runBeforeWrites(hooking.filter(preparation => !embedded.documentFailures.has(preparation)))
      return embedded
    })
    embedding = pass.embedding
    if (pass.called) embeddings += 1
    entry = ctx.requireIndex(indexName)
    const stale = settleDocumentFailures(entry, pass)
    unhooked = hooking.filter(preparation => stale.includes(preparation))
  }
  requireFieldsOf(entry.config.required, preparations)
  await requireMappedVectors(entry, preparations)
  return { entry, embedding }
}

export async function prepareDocumentWrite(
  ctx: MutationContext,
  indexName: string,
  document: AnyDocument,
  hold: IndexHold | undefined,
  beforeWrite: (() => void | Promise<void>) | null,
): Promise<WriteEntry> {
  const preparation: WritePreparation = { document, beforeWrite, failure: undefined }
  const { entry } = await prepareDocumentWrites(ctx, indexName, [preparation], hold, false)
  if (preparation.failure !== undefined) throw preparation.failure
  return entry
}
