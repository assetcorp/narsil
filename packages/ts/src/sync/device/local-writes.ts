import { decode } from '@msgpack/msgpack'
import { getNestedValue } from '../../core/partition/utils'
import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import { encodeDocument } from '../../serialization/document-encoding'
import { restoreVectorFields, setNestedValue, vectorFieldPathsOfSchema } from '../../serialization/vector-field-bytes'
import type { AnyDocument } from '../../types/schema'
import type { KeptEntry, QueuedWrite } from './types'

const NO_VECTOR_FIELDS: ReadonlySet<string> = new Set()

function vectorFieldPathsOf(engine: Narsil, indexName: string): ReadonlySet<string> {
  if (!holdsIndex(engine, indexName)) return NO_VECTOR_FIELDS
  return vectorFieldPathsOfSchema(engine.getStats(indexName).schema)
}

function decodedDocument(bytes: Uint8Array, vectorFieldPaths: ReadonlySet<string>): Record<string, unknown> {
  const document = decode(bytes) as Record<string, unknown>
  restoreVectorFields(document, vectorFieldPaths)
  return document
}

export function documentOfEntry(engine: Narsil, indexName: string, bytes: Uint8Array): AnyDocument {
  return decodedDocument(bytes, vectorFieldPathsOf(engine, indexName)) as AnyDocument
}

export function portableCopyOf(engine: Narsil, indexName: string, document: AnyDocument): AnyDocument {
  const vectorFieldPaths = vectorFieldPathsOf(engine, indexName)
  const copy = decodedDocument(encodeDocument(document), vectorFieldPaths)
  for (const fieldPath of vectorFieldPaths) {
    const vector = getNestedValue(copy, fieldPath)
    if (vector instanceof Float32Array) setNestedValue(copy, fieldPath, Array.from(vector))
  }
  return copy as AnyDocument
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let at = 0; at < left.byteLength; at++) {
    if (left[at] !== right[at]) return false
  }
  return true
}

export function holdsIndex(engine: Narsil, indexName: string): boolean {
  return engine.listIndexes().some(index => index.name === indexName)
}

export async function putLocally(
  engine: Narsil,
  indexName: string,
  documentId: string,
  document: AnyDocument,
): Promise<void> {
  if (await engine.has(indexName, documentId)) {
    await engine.update(indexName, documentId, document)
  } else {
    await engine.insert(indexName, document, documentId)
  }
}

export async function removeLocally(engine: Narsil, indexName: string, documentId: string): Promise<void> {
  try {
    await engine.remove(indexName, documentId)
  } catch (error) {
    if (!(error instanceof NarsilError) || error.code !== ErrorCodes.DOC_NOT_FOUND) throw error
  }
}

async function holdsSameDocument(
  engine: Narsil,
  indexName: string,
  documentId: string,
  encoded: Uint8Array | null,
): Promise<boolean> {
  const held = await engine.get(indexName, documentId)
  if (encoded === null || held === undefined) return encoded === null && held === undefined
  return bytesEqual(encodeDocument(held), encoded)
}

export async function applyEntryLocally(engine: Narsil, indexName: string, entry: KeptEntry): Promise<void> {
  if (await holdsSameDocument(engine, indexName, entry.documentId, entry.document)) return
  if (entry.document === null) {
    await removeLocally(engine, indexName, entry.documentId)
  } else {
    await putLocally(engine, indexName, entry.documentId, documentOfEntry(engine, indexName, entry.document))
  }
}

export async function applyWriteLocally(engine: Narsil, indexName: string, write: QueuedWrite): Promise<void> {
  if (write.document === null) {
    await removeLocally(engine, indexName, write.documentId)
    return
  }
  if (await holdsSameDocument(engine, indexName, write.documentId, encodeDocument(write.document))) return
  await putLocally(engine, indexName, write.documentId, write.document)
}

export function newestByDocument(entries: Iterable<KeptEntry>): Map<string, KeptEntry> {
  const newest = new Map<string, KeptEntry>()
  for (const entry of entries) {
    newest.delete(entry.documentId)
    newest.set(entry.documentId, entry)
  }
  return newest
}
