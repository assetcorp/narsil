import type { SerializedSurfaceForms } from '../../../types/internal'
import type { SegmentPayload } from '../segment-payload'

export interface SegmentPostingColumns {
  postingOffsets: Uint32Array
  postingDocIds: Uint32Array
  postingFrequencies: Uint16Array
  postingFieldIndices: Uint8Array
  positionOffsets: Uint32Array | null
  positionValues: Uint32Array | null
}

export interface SegmentColumns extends SegmentPostingColumns {
  documentCount: number
  fieldNames: readonly string[]
  fieldLengthNames: readonly string[]
  fieldLengthColumns: readonly Uint32Array[]
  totalFieldLengths: Readonly<Record<string, number>>
  numeric: SegmentPayload['numeric']
  boolean: SegmentPayload['boolean']
  enums: SegmentPayload['enums']
  geo: SegmentPayload['geo']
  surfaceForms: SerializedSurfaceForms | null
}
