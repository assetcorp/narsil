import type { SerializedSurfaceForms } from '../../../types/internal'
import type { SegmentPayload } from '../segment-payload'

/**
 * These are the posting arrays every frozen segment holds, in token order,
 * with one run of documents per token and the positions beside them where the
 * segment records positions.
 *
 * @internal
 */
export interface SegmentPostingColumns {
  postingOffsets: Uint32Array
  postingDocIds: Uint32Array
  postingFrequencies: Uint16Array
  postingFieldIndices: Uint8Array
  positionOffsets: Uint32Array | null
  positionValues: Uint32Array | null
}

/**
 * These are the flat columns of one frozen segment, which a reader serves
 * from and a merge reads as they stand, decoding no document.
 *
 * @internal
 */
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
