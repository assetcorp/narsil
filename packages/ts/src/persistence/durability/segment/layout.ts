import { fnv1a } from '../../../core/hash'
import { ErrorCodes, NarsilError } from '../../../errors'

export const SEGMENT_ID_WIDTH = 16
export const VECTOR_PART_WIDTH = 4

export function manifestKey(indexName: string): string {
  return `${indexName}/manifest`
}

export function snapshotBundleKey(indexName: string): string {
  return `${indexName}/snapshot`
}

export function segmentPrefix(indexName: string, partitionId: number): string {
  return `${indexName}/segments/${partitionId}/`
}

export function segmentKey(indexName: string, partitionId: number, segmentId: number): string {
  return `${segmentPrefix(indexName, partitionId)}s${formatSegmentId(segmentId)}`
}

export function segmentsPrefix(indexName: string): string {
  return `${indexName}/segments/`
}

export function vectorSegmentKey(indexName: string, fieldPath: string, generation: number, part: number): string {
  return `${segmentsPrefix(indexName)}vec-${encodeFieldPath(fieldPath)}-g${generation}-p${formatPart(part)}`
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

function formatPart(part: number): string {
  if (!Number.isInteger(part) || part < 0) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, `Vector part ${part} must be a non-negative integer`, {
      part,
    })
  }
  return part.toString().padStart(VECTOR_PART_WIDTH, '0')
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
