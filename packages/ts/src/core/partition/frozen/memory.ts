import type { FrozenSegment } from './index'

/**
 * Reports the bytes one frozen segment's flat arrays hold, read from each
 * array as it stands. A frozen segment keeps its postings, its tokens, its
 * document ids, and its field columns in typed arrays, so every one of those
 * reports its own length and no figure here comes from a count.
 *
 * The field names, the enum values, and the surface forms stay as JavaScript
 * objects, and they fall outside this figure, because no runtime call measures
 * a JavaScript object.
 *
 * @param segment The segment to measure.
 * @returns The bytes that segment's arrays hold. A segment frozen into shared
 * memory reports the bytes the whole process holds once, however many threads
 * have attached it.
 *
 * @internal
 */
export function frozenSegmentBytes(segment: FrozenSegment): number {
  const arrays = segment.arrays
  let bytes = arrays.tokenTable.bytes + arrays.idTable.bytes
  bytes += arrays.postingOffsets.byteLength
  bytes += arrays.postingDocIds.byteLength
  bytes += arrays.postingFrequencies.byteLength
  bytes += arrays.postingFieldIndices.byteLength
  if (arrays.positionOffsets !== null) bytes += arrays.positionOffsets.byteLength
  if (arrays.positionValues !== null) bytes += arrays.positionValues.byteLength
  if (arrays.documentTable !== null) {
    bytes += arrays.documentTable.blob.byteLength + arrays.documentTable.offsets.byteLength
  }
  for (const column of arrays.fieldLengthColumns) bytes += column.byteLength
  for (const entry of arrays.numeric) bytes += entry.docIds.byteLength + entry.values.byteLength
  for (const entry of arrays.boolean) bytes += entry.trueDocs.byteLength + entry.falseDocs.byteLength
  for (const entry of arrays.enums) bytes += entry.offsets.byteLength + entry.docIds.byteLength
  for (const entry of arrays.geo) {
    bytes += entry.docIds.byteLength + entry.latitudes.byteLength + entry.longitudes.byteLength
  }
  return bytes
}
