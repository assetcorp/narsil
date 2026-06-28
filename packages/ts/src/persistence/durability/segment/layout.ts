import { fnv1a } from '../../../core/hash'
import { ErrorCodes, NarsilError } from '../../../errors'

export const DEFAULT_TARGET_SEGMENT_BYTES = 8_388_608

export const DEFAULT_COMPACTION_THRESHOLD = 12

export const SEGMENT_ID_WIDTH = 16

export function manifestKey(indexName: string): string {
  return `${indexName}/manifest`
}

export function legacySnapshotKey(indexName: string): string {
  return `${indexName}/snapshot`
}

export function segmentPrefix(indexName: string, partitionId: number): string {
  return `${indexName}/segments/${partitionId}/`
}

export function segmentKey(indexName: string, partitionId: number, segmentId: number): string {
  return `${segmentPrefix(indexName, partitionId)}s${formatSegmentId(segmentId)}`
}

export function vectorSegmentKey(
  indexName: string,
  partitionId: number,
  fieldPath: string,
  generation: number,
): string {
  return `${segmentPrefix(indexName, partitionId)}vec-${encodeFieldPath(fieldPath)}-g${generation}`
}

function formatSegmentId(segmentId: number): string {
  if (!Number.isInteger(segmentId) || segmentId < 0) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `Segment id ${segmentId} must be a non-negative integer`,
      { segmentId },
    )
  }
  return segmentId.toString().padStart(SEGMENT_ID_WIDTH, '0')
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
  const fingerprint = fnv1a(fieldPath).toString(36)
  return `${fieldPath.replace(/\./g, '_')}-${fingerprint}`
}
