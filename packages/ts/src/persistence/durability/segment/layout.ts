import { fnv1a } from '../../../core/hash'
import { ErrorCodes, NarsilError } from '../../../errors'

export const DEFAULT_INITIAL_BUCKET_COUNT = 1

export const DEFAULT_TARGET_BUCKET_BYTES = 65_536

export const MAX_GLOBAL_DEPTH = 16

export function lowBits(documentId: string, depth: number): number {
  if (depth <= 0) {
    return 0
  }
  const mask = (1 << depth) - 1
  return fnv1a(documentId) & mask
}

export function directorySlot(documentId: string, globalDepth: number): number {
  return lowBits(documentId, globalDepth)
}

export function bucketIdForDocument(documentId: string, globalDepth: number, directory: readonly number[]): number {
  const slot = directorySlot(documentId, globalDepth)
  const bucketId = directory[slot]
  if (bucketId === undefined) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `Directory slot ${slot} is undefined at global depth ${globalDepth}`,
      { slot, globalDepth, directorySize: directory.length },
    )
  }
  return bucketId
}

export function manifestKey(indexName: string): string {
  return `${indexName}/manifest`
}

export function legacySnapshotKey(indexName: string): string {
  return `${indexName}/snapshot`
}

export function segmentPrefix(indexName: string, partitionId: number): string {
  return `${indexName}/segments/${partitionId}/`
}

export function bucketSegmentKey(indexName: string, partitionId: number, bucketId: number, generation: number): string {
  return `${segmentPrefix(indexName, partitionId)}b${bucketId}-g${generation}`
}

export function vectorSegmentKey(
  indexName: string,
  partitionId: number,
  fieldPath: string,
  generation: number,
): string {
  return `${segmentPrefix(indexName, partitionId)}vec-${encodeFieldPath(fieldPath)}-g${generation}`
}

const FIELD_PATH_PATTERN = /^[A-Za-z0-9_.]+$/

export function encodeFieldPath(fieldPath: string): string {
  if (!FIELD_PATH_PATTERN.test(fieldPath)) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `Vector field path "${fieldPath}" contains characters that cannot be encoded in a segment key`,
      { fieldPath },
    )
  }
  // Replacing '.' with '_' can map two distinct paths to the same stem; the appended fnv1a fingerprint
  // makes a collision improbable but does not guarantee uniqueness.
  const fingerprint = fnv1a(fieldPath).toString(36)
  return `${fieldPath.replace(/\./g, '_')}-${fingerprint}`
}
