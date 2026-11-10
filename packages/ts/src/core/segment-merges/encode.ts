import type { NativeKeywordMergeInput } from '../../vector/native/types/segment-merge'
import type { PartitionReadState } from '../partition/read-state'
import { frozenMergeSource } from './frozen-source'
import { growingMergeSource } from './growing-source'
import { mergeKeywordSources, mergeTextAt } from './output'

const EMPTY_BYTES = new Uint8Array(0)
const EMPTY_WORDS = new Uint32Array(0)
const EMPTY_SHORTS = new Uint16Array(0)

export function encodeKeywordRegions(state: PartitionReadState, remap: Int32Array, documentCount: number) {
  const growing = growingMergeSource(state)
  const frozen = growing === null ? frozenMergeSource(state) : null
  if (growing === null && frozen === null) return null
  const fieldNames = state.fieldNameTable.names
  const input: NativeKeywordMergeInput = {
    growing,
    terms: { text: EMPTY_BYTES, offsets: EMPTY_WORDS, counts: EMPTY_WORDS },
    payloadSlots: EMPTY_WORDS,
    postingOffsets: EMPTY_WORDS,
    postingDocuments: EMPTY_WORDS,
    postingFrequencies: EMPTY_SHORTS,
    postingFields: EMPTY_SHORTS,
    positionOffsets: null,
    positionValues: null,
    mapping: new Uint32Array(remap.buffer, remap.byteOffset, remap.length),
    fieldMapping: Uint16Array.from(fieldNames, (_, at) => at),
    fieldLengths: fieldNames.map(field => state.docStore.fieldLengthColumn(field)?.subarray(0, remap.length) ?? null),
    documentCount: remap.length,
    surfaces: null,
    spellings: null,
    ...frozen,
  }
  const output = mergeKeywordSources([input], documentCount, fieldNames.length)
  const tokens: string[] = []
  const docFrequencies: Record<string, number> = Object.create(null)
  for (let at = 0; at < output.terms.counts.length; at++) {
    const token = mergeTextAt(output.terms, at)
    tokens.push(token)
    docFrequencies[token] = output.terms.counts[at]
  }
  const fieldLengthNames = Object.keys(state.stats.totalFieldLengths).filter(name => {
    const field = fieldNames.indexOf(name)
    return field >= 0 && input.fieldLengths[field] !== null
  })
  const fieldLengthColumns: Uint32Array[] = []
  const totalFieldLengths: Record<string, number> = Object.create(null)
  for (const name of fieldLengthNames) {
    const field = fieldNames.indexOf(name)
    fieldLengthColumns.push(output.fieldLengths.subarray(field * documentCount, (field + 1) * documentCount))
    totalFieldLengths[name] = output.totalFieldLengths[field]
  }
  return {
    tokens,
    docFrequencies,
    postingOffsets: output.postingOffsets,
    postingDocIds: output.postingDocuments,
    postingFrequencies: output.postingFrequencies,
    postingFieldIndices: output.postingFields,
    positionOffsets: output.positionOffsets,
    positionValues: output.positionValues,
    fieldLengthNames,
    fieldLengthColumns,
    totalFieldLengths,
  }
}
