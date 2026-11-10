import {
  mergedPartialSpellings,
  mergeKeywordSources,
  mergeSourceSpellings,
  mergeSourceSurfaces,
} from '#platform/storage-host'
import type { NativeKeywordMergeInput } from '../../vector/native/types/segment-merge'
import type { SegmentRemap } from '../partition/frozen/merge-postings'
import type { TextAnalysis } from '../partition/frozen/surface-slot'
import type { FrozenTokenTableData } from '../partition/frozen/token-table'
import type { PartialWordAnalysis } from '../partition/partial-words/spellings'

function emptySource(input: SegmentRemap): NativeKeywordMergeInput {
  return {
    terms: { text: new Uint8Array(), offsets: new Uint32Array(1), counts: new Uint32Array() },
    payloadSlots: new Uint32Array(),
    postingOffsets: new Uint32Array(1),
    postingDocuments: new Uint32Array(),
    postingFrequencies: new Uint16Array(),
    postingFields: new Uint16Array(),
    positionOffsets: null,
    positionValues: null,
    mapping: new Uint32Array(input.remap.buffer, input.remap.byteOffset, input.remap.length),
    fieldMapping: new Uint16Array(),
    fieldLengths: [],
    documentCount: input.remap.length,
    surfaces: null,
    spellings: null,
  }
}

export function mergePagedLengths(inputs: readonly SegmentRemap[], documentCount: number) {
  const fieldNames: string[] = []
  const sources = inputs.map(input => {
    const arrays = input.segment.arrays
    const fieldMapping = Uint16Array.from(
      arrays.fieldLengthNames.map(name => {
        let at = fieldNames.indexOf(name)
        if (at < 0) {
          at = fieldNames.length
          fieldNames.push(name)
        }
        return at
      }),
    )
    return { ...emptySource(input), fieldMapping, fieldLengths: arrays.fieldLengthColumns }
  })
  const merged = mergeKeywordSources(sources, documentCount, fieldNames.length)
  const columns: Uint32Array[] = []
  const totals: Record<string, number> = Object.create(null)
  for (let at = 0; at < fieldNames.length; at++) {
    columns.push(merged.fieldLengths.subarray(at * documentCount, (at + 1) * documentCount))
    totals[fieldNames[at]] = merged.totalFieldLengths[at]
  }
  return { fieldLengthNames: fieldNames, fieldLengthColumns: columns, totalFieldLengths: totals }
}

export function mergePagedStrings(
  inputs: readonly SegmentRemap[],
  documentCount: number,
  terms: FrozenTokenTableData,
  analysis: PartialWordAnalysis | null,
  textAnalysis: TextAnalysis | null,
) {
  const sources = inputs.map(input => ({
    ...emptySource(input),
    surfaces: mergeSourceSurfaces(input, textAnalysis),
    spellings: mergeSourceSpellings(input, analysis),
  }))
  const retained = { text: terms.blob, offsets: terms.offsets, counts: terms.documentFrequencies }
  const output = mergeKeywordSources(sources, documentCount, 0, retained)
  return {
    surfaceTable:
      output.surfaces.counts.length === 0
        ? null
        : {
            blob: output.surfaces.text,
            offsets: output.surfaces.offsets,
            counts: output.surfaces.counts,
          },
    partialSpellings: mergedPartialSpellings(output.spellings, analysis),
  }
}
