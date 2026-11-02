import { littleEndianBytes } from './little-endian'
import { MessagePackChunks } from './msgpack-chunks'
import { postingsInTokenOrder } from './token-order'
import { KEYWORD_SEGMENT_PAYLOAD_VERSION, type KeywordSegmentArrays, type KeywordSegmentContents } from './types'
import { uint64Bytes } from './write-records'

const TOP_LEVEL_ENTRIES = 28

export function writeFieldLengths(
  out: MessagePackChunks,
  arrays: Pick<KeywordSegmentArrays, 'fieldLengthNames' | 'fieldLengthColumns'>,
): void {
  out.array(arrays.fieldLengthNames.length)
  for (let f = 0; f < arrays.fieldLengthNames.length; f++) {
    out.map(2).key('field').value(arrays.fieldLengthNames[f])
    out.key('lengths').binary(littleEndianBytes(arrays.fieldLengthColumns[f]))
  }
}

export function writeValueColumns(out: MessagePackChunks, columns: KeywordSegmentArrays['numeric']): void {
  out.array(columns.length)
  for (const column of columns) {
    out.map(3).key('field').value(column.fieldPath)
    out.key('documents').binary(littleEndianBytes(column.docIds))
    out.key('values').binary(littleEndianBytes(column.values))
  }
}

export function writeBooleanColumns(out: MessagePackChunks, columns: KeywordSegmentArrays['boolean']): void {
  out.array(columns.length)
  for (const column of columns) {
    out.map(3).key('field').value(column.fieldPath)
    out.key('trueDocuments').binary(littleEndianBytes(column.trueDocs))
    out.key('falseDocuments').binary(littleEndianBytes(column.falseDocs))
  }
}

export function writeEnumColumns(out: MessagePackChunks, columns: KeywordSegmentArrays['enums']): void {
  out.array(columns.length)
  for (const column of columns) {
    out.map(4).key('field').value(column.fieldPath)
    out.key('values').value(column.values)
    out.key('offsets').binary(littleEndianBytes(column.offsets))
    out.key('documents').binary(littleEndianBytes(column.docIds))
  }
}

export function writeGeopointColumns(out: MessagePackChunks, columns: KeywordSegmentArrays['geo']): void {
  out.array(columns.length)
  for (const column of columns) {
    out.map(4).key('field').value(column.fieldPath)
    out.key('documents').binary(littleEndianBytes(column.docIds))
    out.key('latitudes').binary(littleEndianBytes(column.latitudes))
    out.key('longitudes').binary(littleEndianBytes(column.longitudes))
  }
}

export function writePatternColumns(out: MessagePackChunks, columns: KeywordSegmentArrays['pattern']): void {
  out.array(columns.length)
  for (const column of columns) {
    out.map(5).key('field').value(column.fieldPath)
    out.key('documents').binary(littleEndianBytes(column.docIds))
    out.key('runs').binary(littleEndianBytes(column.runs))
    out.key('offsets').binary(littleEndianBytes(column.offsets))
    out.key('postings').binary(littleEndianBytes(column.postings))
  }
}

export function writeSurfaceForms(out: MessagePackChunks, arrays: Pick<KeywordSegmentArrays, 'surfaceTable'>): void {
  const table = arrays.surfaceTable
  if (table === null || table.counts.length === 0) {
    out.value(null)
    return
  }
  out.map(3).key('text').binary(table.blob)
  out.key('offsets').binary(littleEndianBytes(table.offsets))
  out.key('counts').binary(littleEndianBytes(table.counts))
}

export function writePartialWords(out: MessagePackChunks, arrays: Pick<KeywordSegmentArrays, 'partialWords'>): void {
  const table = arrays.partialWords
  if (table === null) {
    out.value(null)
    return
  }
  out.map(8).key('fields').value(table.fields)
  out.key('text').binary(table.spellings)
  out.key('offsets').binary(littleEndianBytes(table.spellingOffsets))
  out.key('tokens').binary(littleEndianBytes(table.spellingTokens))
  out.key('counts').binary(littleEndianBytes(table.spellingCounts))
  out.key('runs').binary(littleEndianBytes(table.runs))
  out.key('runOffsets').binary(littleEndianBytes(table.runOffsets))
  out.key('runEntries').binary(littleEndianBytes(table.runEntries))
}

export function encodeKeywordSegment(contents: KeywordSegmentContents): MessagePackChunks {
  const { arrays } = contents
  const postings = postingsInTokenOrder(arrays)
  const out = new MessagePackChunks()
  const { writeRecords } = contents
  out.map(writeRecords === undefined ? TOP_LEVEL_ENTRIES : TOP_LEVEL_ENTRIES + 2)
  out.key('v').value(KEYWORD_SEGMENT_PAYLOAD_VERSION)
  out.key('schema').value(contents.schema)
  out.key('tombstones').value(contents.tombstones)
  out.key('documentCount').value(arrays.documentCount)
  out.key('ids').binary(arrays.idTable.blob)
  out.key('idOffsets').binary(littleEndianBytes(arrays.idTable.offsets))
  out.key('idOrder').binary(littleEndianBytes(arrays.idTable.sortedOrdinals))
  out.key('documents').binary(arrays.documentTable.blob)
  out.key('documentOffsets').binary(littleEndianBytes(arrays.documentTable.offsets))
  out.key('fieldNames').value(arrays.fieldNames)
  out.key('tokens').binary(arrays.tokenTable.blob)
  out.key('tokenOffsets').binary(littleEndianBytes(arrays.tokenTable.offsets))
  out.key('documentFrequencies').binary(littleEndianBytes(arrays.tokenTable.documentFrequencies))
  out.key('postingOffsets').binary(littleEndianBytes(postings.postingOffsets))
  out.key('postingDocuments').binary(littleEndianBytes(postings.postingDocIds))
  out.key('postingFrequencies').binary(littleEndianBytes(postings.postingFrequencies))
  out.key('postingFields').binary(littleEndianBytes(postings.postingFieldIndices))
  out
    .key('positionOffsets')
    .binaryOrNil(postings.positionOffsets === null ? null : littleEndianBytes(postings.positionOffsets))
  out.key('positions').binaryOrNil(postings.positionValues === null ? null : littleEndianBytes(postings.positionValues))
  out.key('fieldLengths')
  writeFieldLengths(out, arrays)
  out.key('numeric')
  writeValueColumns(out, arrays.numeric)
  out.key('sizes')
  writeValueColumns(out, arrays.sizes)
  out.key('boolean')
  writeBooleanColumns(out, arrays.boolean)
  out.key('enum')
  writeEnumColumns(out, arrays.enums)
  out.key('geopoint')
  writeGeopointColumns(out, arrays.geo)
  out.key('pattern')
  writePatternColumns(out, arrays.pattern)
  out.key('surfaceForms')
  writeSurfaceForms(out, arrays)
  out.key('partialWords')
  writePartialWords(out, arrays)
  if (writeRecords !== undefined) {
    out.key('seqNos').binary(uint64Bytes(writeRecords.seqNos))
    out.key('primaryTerms').binary(uint64Bytes(writeRecords.primaryTerms))
  }
  return out
}
