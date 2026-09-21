import type { FrozenSegment } from './index'

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
