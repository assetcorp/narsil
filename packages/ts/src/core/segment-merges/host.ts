import {
  createSurfaceRegistry,
  encodePartialSpellingsOf,
  encodeStringBlob,
  encodeSurfaceTable,
  mergeKeywordSources,
  mergeTextAt,
  SegmentRefusal,
} from '#platform/segment-merge-host'
import type { NativeFrozenStrings } from '../../vector/native/types/frozen-segments'
import type { NativeKeywordMergeInput } from '../../vector/native/types/segment-merge'
import type { SegmentRemap } from '../partition/frozen/merge-postings'
import type { EncodedSegmentPayload } from '../partition/frozen/shared-snapshot'
import type { TextAnalysis } from '../partition/frozen/surface-slot'
import type { PartialSpellings, PartialWordAnalysis, SpellingCounts } from '../partition/partial-words/spellings'

export function mergeSourceSurfaces(input: SegmentRemap, analysis: TextAnalysis | null): NativeFrozenStrings {
  const registry = createSurfaceRegistry()
  input.segment.surfaces.addKeptForms(registry, input.remap, analysis)
  const forms = registry.serialize()
  for (const value of Object.values(forms)) {
    if (Array.isArray(value) && value[0] > 0xffffffff) throw new SegmentRefusal(8)
  }
  const table = encodeSurfaceTable(forms)
  return { text: table.blob, offsets: table.offsets, counts: table.counts }
}

export function mergeSourceSpellings(
  input: SegmentRemap,
  analysis: PartialWordAnalysis | null,
): NativeFrozenStrings | null {
  if (analysis === null || analysis.fields.length === 0) return null
  const counts: SpellingCounts = new Map()
  input.segment.partialWords.countKeptSpellings(counts, analysis, input.remap)
  const values = encodePartialSpellingsOf(analysis.fields, counts)
  const pairs: string[] = []
  for (let at = 0; at < values.counts.length; at++) {
    if (values.counts[at] > 0xffffffff) throw new SegmentRefusal(8)
    pairs.push(values.spellings[at], values.tokens[at])
  }
  const table = encodeStringBlob(pairs)
  return { text: table.blob, offsets: table.offsets, counts: Uint32Array.from(values.counts) }
}

function source(
  input: SegmentRemap,
  analysis: PartialWordAnalysis | null,
  textAnalysis: TextAnalysis | null,
): NativeKeywordMergeInput {
  const arrays = input.segment.arrays
  const terms = arrays.tokenTable.data
  return {
    terms: { text: terms.blob, offsets: terms.offsets, counts: terms.documentFrequencies },
    payloadSlots: terms.payloadSlots,
    postingOffsets: arrays.postingOffsets,
    postingDocuments: arrays.postingDocIds,
    postingFrequencies: arrays.postingFrequencies,
    postingFields: arrays.postingFieldIndices,
    positionOffsets: arrays.positionOffsets,
    positionValues: arrays.positionValues,
    mapping: new Uint32Array(input.remap.buffer, input.remap.byteOffset, input.remap.length),
    fieldMapping: input.fieldIndexRemap,
    fieldLengths: arrays.fieldNames.map(field => {
      const at = arrays.fieldLengthNames.indexOf(field)
      return at < 0 ? null : arrays.fieldLengthColumns[at]
    }),
    documentCount: arrays.documentCount,
    surfaces: mergeSourceSurfaces(input, textAnalysis),
    spellings: mergeSourceSpellings(input, analysis),
  }
}

export function mergedPartialSpellings(
  table: NativeFrozenStrings,
  analysis: PartialWordAnalysis | null,
): PartialSpellings | null {
  if (analysis === null || analysis.fields.length === 0) return null
  const values: PartialSpellings = { fields: [...analysis.fields], tokens: [], spellings: [], counts: [] }
  for (let at = 0; at < table.counts.length; at++) {
    values.spellings.push(mergeTextAt(table, at * 2))
    values.tokens.push(mergeTextAt(table, at * 2 + 1))
    values.counts.push(table.counts[at])
  }
  return values
}

export function mergeKeywordColumns(
  inputs: readonly SegmentRemap[],
  documentCount: number,
  fieldNames: readonly string[],
  analysis: PartialWordAnalysis | null,
  textAnalysis: TextAnalysis | null,
): Pick<
  EncodedSegmentPayload,
  | 'tokenTable'
  | 'postingOffsets'
  | 'postingDocIds'
  | 'postingFrequencies'
  | 'postingFieldIndices'
  | 'positionOffsets'
  | 'positionValues'
  | 'fieldLengthNames'
  | 'fieldLengthColumns'
  | 'totalFieldLengths'
  | 'surfaceTable'
  | 'partialSpellings'
> {
  const sources = inputs.map(input => source(input, analysis, textAnalysis))
  const output = mergeKeywordSources(sources, documentCount, fieldNames.length)
  const termCount = output.terms.counts.length
  const payloadSlots = new Uint32Array(termCount)
  for (let at = 0; at < termCount; at++) payloadSlots[at] = at
  const fieldLengthNames: string[] = []
  const fieldLengthColumns: Uint32Array[] = []
  const totalFieldLengths: Record<string, number> = Object.create(null)
  for (const input of inputs) {
    for (const name of input.segment.arrays.fieldLengthNames) {
      if (fieldLengthNames.includes(name)) continue
      const field = fieldNames.indexOf(name)
      fieldLengthNames.push(name)
      fieldLengthColumns.push(output.fieldLengths.subarray(field * documentCount, (field + 1) * documentCount))
      totalFieldLengths[name] = output.totalFieldLengths[field]
    }
  }
  return {
    tokenTable: {
      blob: output.terms.text,
      offsets: output.terms.offsets,
      payloadSlots,
      documentFrequencies: output.terms.counts,
    },
    fieldLengthNames,
    fieldLengthColumns,
    totalFieldLengths,
    postingOffsets: output.postingOffsets,
    postingDocIds: output.postingDocuments,
    postingFrequencies: output.postingFrequencies,
    postingFieldIndices: output.postingFields,
    positionOffsets: output.positionOffsets,
    positionValues: output.positionValues,
    surfaceTable:
      output.surfaces.counts.length === 0
        ? null
        : { blob: output.surfaces.text, offsets: output.surfaces.offsets, counts: output.surfaces.counts },
    partialSpellings: mergedPartialSpellings(output.spellings, analysis),
  }
}
