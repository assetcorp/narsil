import { decode } from '@msgpack/msgpack'
import { requireValidFieldTypes } from '../../schema/validator/schema'
import { VECTOR_PATTERN } from '../../schema/validator/shared'
import {
  type ColumnContext,
  decodeBooleanColumns,
  decodeEnumColumns,
  decodeFieldLengths,
  decodeGeopointColumns,
  decodePartialWords,
  decodePatternColumns,
  decodeSurfaceForms,
  decodeValueColumns,
} from './decode-columns'
import { bytesFrom, uint16sFrom, uint32sFrom } from './little-endian'
import {
  corrupt,
  requireBytes,
  requireBytesOrNil,
  requireCount,
  requireRecord,
  requireStrings,
  requireUint32,
} from './raw-fields'
import {
  KEYWORD_SEGMENT_PAYLOAD_VERSION,
  type KeywordSegmentArrays,
  type KeywordSegmentContents,
  MAX_SEGMENT_FIELD_NAMES,
} from './types'
import {
  requireEntriesAscend,
  requireOffsets,
  requireOrdinals,
  requirePermutation,
  requireUtf8Entries,
} from './validate'
import { decodeWriteRecords } from './write-records'

function decodeSchema(raw: unknown): Record<string, string> {
  const schema = requireRecord(raw, 'schema')
  requireValidFieldTypes(schema)
  return schema as Record<string, string>
}

function decodeIds(raw: Record<string, unknown>, context: ColumnContext): KeywordSegmentArrays['idTable'] {
  const blob = bytesFrom(requireBytes(raw.ids, 'ids', 1), context.shared)
  const offsets = uint32sFrom(requireBytes(raw.idOffsets, 'idOffsets', 4), context.shared)
  const sortedOrdinals = uint32sFrom(requireBytes(raw.idOrder, 'idOrder', 4), context.shared)
  requireCount(offsets.length, context.documentCount + 1, 'idOffsets')
  requireCount(sortedOrdinals.length, context.documentCount, 'idOrder')
  requireOffsets(offsets, blob.length, 'idOffsets')
  requireUtf8Entries(blob, offsets, 'ids')
  requirePermutation(sortedOrdinals, 'idOrder')
  requireEntriesAscend(blob, offsets, sortedOrdinals, 'ids')
  return { blob, offsets, sortedOrdinals }
}

function vectorFieldPathsOf(schema: Record<string, string>): string[] {
  return Object.keys(schema).filter(fieldPath => VECTOR_PATTERN.test(schema[fieldPath]))
}

function decodeDocuments(
  raw: Record<string, unknown>,
  schema: Record<string, string>,
  context: ColumnContext,
): KeywordSegmentArrays['documentTable'] {
  const blob = bytesFrom(requireBytes(raw.documents, 'documents', 1), context.shared)
  const offsets = uint32sFrom(requireBytes(raw.documentOffsets, 'documentOffsets', 4), context.shared)
  requireCount(offsets.length, context.documentCount + 1, 'documentOffsets')
  requireOffsets(offsets, blob.length, 'documentOffsets')
  const discardedFields = vectorFieldPathsOf(schema)
  return discardedFields.length === 0 ? { blob, offsets } : { blob, offsets, discardedFields }
}

function identitySlots(count: number, shared: boolean): Uint32Array {
  const slots = uint32sFrom(new Uint8Array(count * 4), shared)
  for (let at = 0; at < count; at++) slots[at] = at
  return slots
}

function requireDocumentFrequencies(frequencies: Uint32Array, postingOffsets: Uint32Array): void {
  for (let token = 0; token < frequencies.length; token++) {
    const postings = postingOffsets[token + 1] - postingOffsets[token]
    if (frequencies[token] === 0 || frequencies[token] > postings) {
      corrupt(`documentFrequencies gives token ${token} a count of ${frequencies[token]} over ${postings} postings`, {
        token,
      })
    }
  }
}

function requireFieldNumbers(fields: Uint16Array, fieldNames: number): void {
  for (let at = 0; at < fields.length; at++) {
    if (fields[at] >= fieldNames) corrupt(`postingFields names field ${fields[at]} of ${fieldNames}`, { at })
  }
}

function decodePostings(
  raw: Record<string, unknown>,
  fieldNames: readonly string[],
  context: ColumnContext,
): Pick<
  KeywordSegmentArrays,
  | 'tokenTable'
  | 'postingOffsets'
  | 'postingDocIds'
  | 'postingFrequencies'
  | 'postingFieldIndices'
  | 'positionOffsets'
  | 'positionValues'
> {
  const blob = bytesFrom(requireBytes(raw.tokens, 'tokens', 1), context.shared)
  const offsets = uint32sFrom(requireBytes(raw.tokenOffsets, 'tokenOffsets', 4), context.shared)
  requireOffsets(offsets, blob.length, 'tokenOffsets')
  requireUtf8Entries(blob, offsets, 'tokens')
  requireEntriesAscend(blob, offsets, null, 'tokens')
  const tokens = offsets.length - 1
  const documentFrequencies = uint32sFrom(
    requireBytes(raw.documentFrequencies, 'documentFrequencies', 4),
    context.shared,
  )
  const postingOffsets = uint32sFrom(requireBytes(raw.postingOffsets, 'postingOffsets', 4), context.shared)
  const postingDocIds = uint32sFrom(requireBytes(raw.postingDocuments, 'postingDocuments', 4), context.shared)
  const postingFrequencies = uint16sFrom(requireBytes(raw.postingFrequencies, 'postingFrequencies', 2), context.shared)
  const postingFieldIndices = uint16sFrom(requireBytes(raw.postingFields, 'postingFields', 2), context.shared)
  requireCount(documentFrequencies.length, tokens, 'documentFrequencies')
  requireCount(postingOffsets.length, tokens + 1, 'postingOffsets')
  requireOffsets(postingOffsets, postingDocIds.length, 'postingOffsets')
  requireCount(postingFrequencies.length, postingDocIds.length, 'postingFrequencies')
  requireCount(postingFieldIndices.length, postingDocIds.length, 'postingFields')
  requireOrdinals(postingDocIds, context.documentCount, 'postingDocuments')
  requireFieldNumbers(postingFieldIndices, fieldNames.length)
  requireDocumentFrequencies(documentFrequencies, postingOffsets)

  const rawPositionOffsets = requireBytesOrNil(raw.positionOffsets, 'positionOffsets', 4)
  const rawPositions = requireBytesOrNil(raw.positions, 'positions', 4)
  if ((rawPositionOffsets === null) !== (rawPositions === null)) {
    corrupt('positionOffsets and positions must both be nil or both hold bytes')
  }
  let positionOffsets: Uint32Array | null = null
  let positionValues: Uint32Array | null = null
  if (rawPositionOffsets !== null && rawPositions !== null) {
    positionOffsets = uint32sFrom(rawPositionOffsets, context.shared)
    positionValues = uint32sFrom(rawPositions, context.shared)
    requireCount(positionOffsets.length, postingDocIds.length + 1, 'positionOffsets')
    requireOffsets(positionOffsets, positionValues.length, 'positionOffsets')
  }

  return {
    tokenTable: { blob, offsets, payloadSlots: identitySlots(tokens, context.shared), documentFrequencies },
    postingOffsets,
    postingDocIds,
    postingFrequencies,
    postingFieldIndices,
    positionOffsets,
    positionValues,
  }
}

export function decodeKeywordSegment(payload: Uint8Array, shared: boolean): KeywordSegmentContents {
  let decoded: unknown
  try {
    decoded = decode(payload)
  } catch (error) {
    corrupt(`payload is not MessagePack: ${error instanceof Error ? error.message : String(error)}`)
  }
  const raw = requireRecord(decoded, 'payload')
  if (raw.v !== KEYWORD_SEGMENT_PAYLOAD_VERSION) {
    corrupt(`payload version ${String(raw.v)} is not ${KEYWORD_SEGMENT_PAYLOAD_VERSION}`, { version: raw.v })
  }
  const schema = decodeSchema(raw.schema)
  const tombstones = requireStrings(raw.tombstones, 'tombstones')
  const documentCount = requireUint32(raw.documentCount, 'documentCount')
  const fieldNames = requireStrings(raw.fieldNames, 'fieldNames')
  if (fieldNames.length > MAX_SEGMENT_FIELD_NAMES) {
    corrupt(`fieldNames holds ${fieldNames.length} names, above the limit of ${MAX_SEGMENT_FIELD_NAMES}`)
  }
  const context: ColumnContext = { documentCount, shared }
  const postings = decodePostings(raw, fieldNames, context)
  const arrays: KeywordSegmentArrays = {
    documentCount,
    fieldNames,
    idTable: decodeIds(raw, context),
    documentTable: decodeDocuments(raw, schema, context),
    ...postings,
    ...decodeFieldLengths(raw.fieldLengths, context),
    numeric: decodeValueColumns(raw.numeric, 'numeric', context),
    sizes: decodeValueColumns(raw.sizes, 'sizes', context),
    boolean: decodeBooleanColumns(raw.boolean, context),
    enums: decodeEnumColumns(raw.enum, context),
    geo: decodeGeopointColumns(raw.geopoint, context),
    pattern: decodePatternColumns(raw.pattern, context),
    surfaceTable: decodeSurfaceForms(raw.surfaceForms, context),
    partialWords: decodePartialWords(raw.partialWords, postings.tokenTable.offsets.length - 1, context),
  }
  const writeRecords = decodeWriteRecords(raw, documentCount)
  return writeRecords === null ? { schema, tombstones, arrays } : { schema, tombstones, arrays, writeRecords }
}
