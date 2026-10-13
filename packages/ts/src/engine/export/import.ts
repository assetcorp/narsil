import { ErrorCodes, NarsilError, type NarsilErrorCode } from '../../errors'
import { flattenSchema } from '../../schema/validator'
import type { ByteSource, Narsil } from '../../types/engine'
import type { DocumentImportResult } from '../../types/results'
import type { AnyDocument, IndexConfig, SchemaDefinition } from '../../types/schema'
import { IMPORT_BATCH_DOCUMENTS, MAX_EXPORT_LINE_BYTES, MAX_IMPORT_REFUSALS_REPORTED } from '../constants'
import { requireConfigurationShape } from '../snapshot/index-configuration'
import { restoredConfigFields, restoredEmbedding } from '../snapshot/restore-config'
import { type ExportLine, exportLines } from './lines'
import { untagDocumentLine } from './tags'
import { DOCUMENT_EXPORT_FORMAT, DOCUMENT_EXPORT_VERSION } from './write'

interface PendingDocument {
  line: number
  docId: string
  document: AnyDocument
}

interface ImportState {
  engine: Narsil
  indexName: string
  batch: PendingDocument[]
  batchIds: Set<string>
  result: DocumentImportResult
  highestReported: number
}

function invalidHeader(message: string): never {
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, `The document export header ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configOfHeader(line: ExportLine | undefined): IndexConfig {
  if (line === undefined) invalidHeader('is missing')
  if (!('text' in line)) {
    invalidHeader(
      line.refused === 'too-long' ? `passes the line limit of ${MAX_EXPORT_LINE_BYTES} bytes` : 'is not UTF-8',
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(line.text)
  } catch {
    invalidHeader('is not JSON')
  }
  if (!isRecord(raw) || raw.format !== DOCUMENT_EXPORT_FORMAT || raw.version !== DOCUMENT_EXPORT_VERSION) {
    invalidHeader(`must name format "${DOCUMENT_EXPORT_FORMAT}" and version ${DOCUMENT_EXPORT_VERSION}`)
  }
  const configuration = requireConfigurationShape(raw.index, 'document export header')
  const fields = restoredConfigFields(configuration, message => invalidHeader(message))
  const embedding = restoredEmbedding(configuration.embedding, message => invalidHeader(message))
  return {
    schema: configuration.schema as SchemaDefinition,
    language: configuration.language,
    ...fields,
    ...(embedding === undefined
      ? {}
      : {
          embedding: {
            fields: embedding.fields,
            ...(embedding.adapter === undefined ? {} : { adapter: embedding.adapter }),
          },
        }),
  }
}

async function prepareIndex(engine: Narsil, indexName: string, config: IndexConfig): Promise<void> {
  if (!engine.listIndexes().some(index => index.name === indexName)) {
    await engine.createIndex(indexName, config)
    return
  }
  const existing = flattenSchema(engine.getStats(indexName).schema as SchemaDefinition)
  const exported = flattenSchema(config.schema)
  const fields = new Set([...Object.keys(existing), ...Object.keys(exported)])
  for (const field of fields) {
    if (existing[field] === exported[field]) continue
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `Index "${indexName}" gives field "${field}" another type than the export does, so the import cannot write into it`,
      { indexName, field },
    )
  }
}

function highestReportedAt(refused: DocumentImportResult['refused']): number {
  let highest = 0
  for (let at = 1; at < refused.length; at++) {
    if (refused[at].line > refused[highest].line) highest = at
  }
  return highest
}

function refuse(state: ImportState, line: number, code: NarsilErrorCode, message: string): void {
  state.result.refusedCount += 1
  const refused = state.result.refused
  if (refused.length < MAX_IMPORT_REFUSALS_REPORTED) {
    refused.push({ line, code, message })
    if (refused.length === MAX_IMPORT_REFUSALS_REPORTED) state.highestReported = highestReportedAt(refused)
    return
  }
  if (line >= refused[state.highestReported].line) return
  refused[state.highestReported] = { line, code, message }
  state.highestReported = highestReportedAt(refused)
}

async function flush(state: ImportState): Promise<void> {
  if (state.batch.length === 0) return
  const batch = state.batch
  state.batch = []
  state.batchIds = new Set()
  const lineOf = new Map(batch.map(entry => [entry.docId, entry.line]))
  const inserts: AnyDocument[] = []
  const updates: Array<{ docId: string; document: AnyDocument }> = []
  for (const entry of batch) {
    if (await state.engine.has(state.indexName, entry.docId))
      updates.push({ docId: entry.docId, document: entry.document })
    else inserts.push(entry.document)
  }
  for (const outcome of [
    inserts.length === 0 ? null : await state.engine.insertBatch(state.indexName, inserts, { skipClone: true }),
    updates.length === 0 ? null : await state.engine.updateBatch(state.indexName, updates),
  ]) {
    if (outcome === null) continue
    state.result.imported += outcome.succeeded.length
    for (const failure of outcome.failed) {
      const code = failure.error instanceof NarsilError ? failure.error.code : ErrorCodes.DOC_VALIDATION_FAILED
      refuse(state, lineOf.get(failure.docId) ?? 0, code, failure.error.message)
    }
  }
}

async function takeLine(state: ImportState, entry: ExportLine): Promise<void> {
  if (!('text' in entry)) {
    const message =
      entry.refused === 'too-long'
        ? `The line passes the limit of ${MAX_EXPORT_LINE_BYTES} bytes`
        : 'The line is not UTF-8'
    refuse(state, entry.line, ErrorCodes.DOC_VALIDATION_FAILED, message)
    return
  }
  if (entry.text.length === 0) return
  let document: unknown
  try {
    document = JSON.parse(entry.text)
  } catch {
    refuse(state, entry.line, ErrorCodes.DOC_VALIDATION_FAILED, 'The line is not JSON')
    return
  }
  if (!isRecord(document) || typeof document.id !== 'string' || document.id.length === 0) {
    refuse(state, entry.line, ErrorCodes.DOC_VALIDATION_FAILED, 'The line holds no document with a string id')
    return
  }
  try {
    untagDocumentLine(entry.text, document)
  } catch (error) {
    if (!(error instanceof NarsilError)) throw error
    refuse(state, entry.line, error.code, error.message)
    return
  }
  if (state.batchIds.has(document.id)) await flush(state)
  state.batch.push({ line: entry.line, docId: document.id, document: document as AnyDocument })
  state.batchIds.add(document.id)
  if (state.batch.length >= IMPORT_BATCH_DOCUMENTS) await flush(state)
}

export async function readDocumentExport(
  engine: Narsil,
  indexName: string,
  source: ByteSource,
): Promise<DocumentImportResult> {
  const lines = exportLines(source, MAX_EXPORT_LINE_BYTES)
  const header = await lines.next()
  await prepareIndex(engine, indexName, configOfHeader(header.done === true ? undefined : header.value))
  const state: ImportState = {
    engine,
    indexName,
    batch: [],
    batchIds: new Set(),
    result: { imported: 0, refusedCount: 0, refused: [] },
    highestReported: 0,
  }
  for await (const entry of lines) await takeLine(state, entry)
  await flush(state)
  state.result.refused.sort((a, b) => a.line - b.line)
  return state.result
}
