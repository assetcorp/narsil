import { setNestedValue } from '../../../partitioning/manager/nested-values'
import type { AnyDocument } from '../../../types/schema'
import { SEARCH_CONTEXT_ENTRY_HEAP_BYTES } from '../constants'
import type { DocumentSnapshot } from './snapshots'

export function documentOfSnapshot(snapshot: DocumentSnapshot, withVectors = true): AnyDocument {
  const document = structuredClone(snapshot.fields) as Record<string, unknown>
  if (!withVectors) return document as AnyDocument
  for (const [fieldPath, vector] of snapshot.vectors) setNestedValue(document, fieldPath, new Float32Array(vector))
  return document as AnyDocument
}

export function heldBytesOf(snapshots: ReadonlyMap<string, DocumentSnapshot>): number {
  let bytes = 0
  for (const snapshot of snapshots.values()) {
    bytes += SEARCH_CONTEXT_ENTRY_HEAP_BYTES
    for (const [, vector] of snapshot.vectors) bytes += vector.byteLength
  }
  return bytes
}
