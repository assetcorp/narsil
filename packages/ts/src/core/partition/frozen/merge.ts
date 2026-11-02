import { encodeDocument } from '../../../serialization/document-encoding'
import { topLevelMapKeys } from '../../../serialization/msgpack-without-fields'
import type { SerializedSurfaceForms } from '../../../types/internal'
import { createSurfaceRegistry } from '../../surface-registry'
import { encodePartialSpellingsOf } from '../partial-words/registry'
import type { PartialSpellings, PartialWordAnalysis, SpellingCounts } from '../partial-words/spellings'
import type { PartialWordTableData } from '../partial-words/types'
import type { SegmentPayload } from '../segment-payload'
import type { EncodedDocumentTableData } from './document-source'
import type { FrozenSegment } from './index'
import { mergeFieldIndexes } from './merge-fields'
import { mergePostings, type SegmentRemap } from './merge-postings'
import { freezeEncodedSegmentShared, type SharedSegmentSnapshot } from './shared-snapshot'
import type { TextAnalysis } from './surface-slot'

export interface SegmentSelection {
  segment: FrozenSegment
  keep?: (ordinal: number) => boolean
}

export interface MergedSegmentContents {
  payload: SegmentPayload
  documents: EncodedDocumentTableData
  reusedPartialWords: PartialWordTableData | null
}

interface MergedPartialWords {
  spellings: PartialSpellings | null
  reused: PartialWordTableData | null
}

export function selectionKeeps(selection: SegmentSelection, ordinal: number): boolean {
  return selection.keep === undefined ? !selection.segment.isTombstoned(ordinal) : selection.keep(ordinal)
}

function remapOf(selection: SegmentSelection, docIds: string[]): Int32Array {
  const { segment } = selection
  const count = segment.arrays.documentCount
  const remap = new Int32Array(count).fill(-1)
  for (let ordinal = 0; ordinal < count; ordinal++) {
    if (!selectionKeeps(selection, ordinal)) continue
    remap[ordinal] = docIds.length
    docIds.push(segment.arrays.idTable.idAt(ordinal))
  }
  return remap
}

function fieldNameIndex(fieldNames: string[], name: string): number {
  const at = fieldNames.indexOf(name)
  if (at >= 0) return at
  fieldNames.push(name)
  return fieldNames.length - 1
}

export function fieldIndexRemapOf(segment: FrozenSegment, fieldNames: string[]): Uint16Array {
  const remap = new Uint16Array(segment.arrays.fieldNames.length)
  for (let i = 0; i < segment.arrays.fieldNames.length; i++) {
    remap[i] = fieldNameIndex(fieldNames, segment.arrays.fieldNames[i])
  }
  return remap
}

export function mergeFieldLengths(
  inputs: readonly SegmentRemap[],
  documentCount: number,
): Pick<SegmentPayload, 'fieldLengthNames' | 'fieldLengthColumns' | 'totalFieldLengths'> {
  const names: string[] = []
  const columns: Uint32Array[] = []
  const totals: Record<string, number> = {}
  for (const input of inputs) {
    const arrays = input.segment.arrays
    const remap = input.remap
    for (let f = 0; f < arrays.fieldLengthNames.length; f++) {
      const name = arrays.fieldLengthNames[f]
      let at = names.indexOf(name)
      if (at < 0) {
        at = names.length
        names.push(name)
        columns.push(new Uint32Array(documentCount))
        totals[name] = 0
      }
      const source = arrays.fieldLengthColumns[f]
      const column = columns[at]
      for (let ordinal = 0; ordinal < source.length; ordinal++) {
        const target = remap[ordinal]
        if (target < 0) continue
        column[target] = source[ordinal]
        totals[name] += source[ordinal]
      }
    }
  }
  return { fieldLengthNames: names, fieldLengthColumns: columns, totalFieldLengths: totals }
}

export function mergeSurfaceForms(
  inputs: readonly SegmentRemap[],
  analysis: TextAnalysis | null,
): SerializedSurfaceForms | null {
  const registry = createSurfaceRegistry()
  for (const input of inputs) input.segment.surfaces.addKeptForms(registry, input.remap, analysis)
  return registry.size() === 0 ? null : registry.serialize()
}

export function holdsADiscardedField(bytes: Uint8Array, discardedFields: readonly string[]): boolean {
  const keys = topLevelMapKeys(bytes)
  if (keys === null) return true
  for (const fieldPath of discardedFields) {
    const dot = fieldPath.indexOf('.')
    if (keys.has(dot < 0 ? fieldPath : fieldPath.slice(0, dot))) return true
  }
  return false
}

function encodedDocumentsOf(input: SegmentRemap): (ordinal: number) => Uint8Array {
  const table = input.segment.arrays.documentTable
  const encoded: Array<Uint8Array | undefined> = new Array(input.remap.length)
  const encodeOrdinal = (ordinal: number): Uint8Array => {
    let bytes = encoded[ordinal]
    if (bytes === undefined) {
      bytes = encodeDocument(input.segment.documentSource.docAt(ordinal))
      encoded[ordinal] = bytes
    }
    return bytes
  }
  if (table === null) return encodeOrdinal
  const discardedFields = table.discardedFields
  return ordinal => {
    if (encoded[ordinal] !== undefined) return encodeOrdinal(ordinal)
    const stored = table.blob.subarray(table.offsets[ordinal], table.offsets[ordinal + 1])
    if (discardedFields === undefined || !holdsADiscardedField(stored, discardedFields)) return stored
    return encodeOrdinal(ordinal)
  }
}

function mergeDocuments(inputs: readonly SegmentRemap[], documentCount: number): EncodedDocumentTableData {
  const readers = inputs.map(encodedDocumentsOf)
  const offsets = new Uint32Array(documentCount + 1)
  for (let i = 0; i < inputs.length; i++) {
    const { remap } = inputs[i]
    for (let ordinal = 0; ordinal < remap.length; ordinal++) {
      if (remap[ordinal] >= 0) offsets[remap[ordinal] + 1] = readers[i](ordinal).length
    }
  }
  for (let ordinal = 0; ordinal < documentCount; ordinal++) offsets[ordinal + 1] += offsets[ordinal]
  const blob = new Uint8Array(offsets[documentCount])
  for (let i = 0; i < inputs.length; i++) {
    const { remap } = inputs[i]
    for (let ordinal = 0; ordinal < remap.length; ordinal++) {
      const target = remap[ordinal]
      if (target >= 0) blob.set(readers[i](ordinal), offsets[target])
    }
  }
  return { blob, offsets }
}

function keepsEveryDocument(remap: Int32Array): boolean {
  for (let ordinal = 0; ordinal < remap.length; ordinal++) {
    if (remap[ordinal] < 0) return false
  }
  return true
}

export function mergePartialWords(
  inputs: readonly SegmentRemap[],
  mergedTokenCount: number,
  analysis: PartialWordAnalysis | null,
): MergedPartialWords {
  if (analysis === null || analysis.fields.length === 0) return { spellings: null, reused: null }
  if (inputs.length === 1) {
    const [only] = inputs
    const table = only.segment.partialWords.tableOfEveryDocument(analysis)
    const keepsTokens = mergedTokenCount === only.segment.arrays.tokenTable.size
    if (table !== null && keepsTokens && keepsEveryDocument(only.remap)) return { spellings: null, reused: table }
  }
  const counts: SpellingCounts = new Map()
  for (const input of inputs) input.segment.partialWords.countKeptSpellings(counts, analysis, input.remap)
  return { spellings: encodePartialSpellingsOf(analysis.fields, counts), reused: null }
}

export function mergeFrozenSegments(
  segments: readonly FrozenSegment[],
  analysis: PartialWordAnalysis | null,
  textAnalysis: TextAnalysis | null,
): SharedSegmentSnapshot | null {
  if (typeof SharedArrayBuffer !== 'function') return null
  const merged = mergeSegmentContents(
    segments.map(segment => ({ segment })),
    analysis,
    textAnalysis,
  )
  return freezeEncodedSegmentShared(merged.payload, merged.documents, undefined, analysis, merged.reusedPartialWords)
}

export function mergeSegmentContents(
  selections: readonly SegmentSelection[],
  analysis: PartialWordAnalysis | null = null,
  textAnalysis: TextAnalysis | null = null,
): MergedSegmentContents {
  const docIds: string[] = []
  const fieldNames: string[] = []
  const inputs: SegmentRemap[] = selections.map(selection => ({
    segment: selection.segment,
    remap: remapOf(selection, docIds),
    fieldIndexRemap: fieldIndexRemapOf(selection.segment, fieldNames),
  }))
  const documentCount = docIds.length
  const postings = mergePostings(inputs)
  const lengths = mergeFieldLengths(inputs, documentCount)
  const partialWords = mergePartialWords(inputs, postings.tokens.length, analysis)

  const payload: SegmentPayload = {
    documentCount,
    docIds,
    fieldNames,
    tokens: postings.tokens,
    postingOffsets: postings.postingOffsets,
    postingDocIds: postings.postingDocIds,
    postingFrequencies: postings.postingFrequencies,
    postingFieldIndices: postings.postingFieldIndices,
    positionOffsets: postings.positionOffsets,
    positionValues: postings.positionValues,
    fieldLengthNames: lengths.fieldLengthNames,
    fieldLengthColumns: lengths.fieldLengthColumns,
    totalFieldLengths: lengths.totalFieldLengths,
    docFrequencies: postings.docFrequencies,
    surfaceForms: mergeSurfaceForms(inputs, textAnalysis),
    partialSpellings: partialWords.spellings,
    ...mergeFieldIndexes(inputs),
  }

  return { payload, documents: mergeDocuments(inputs, documentCount), reusedPartialWords: partialWords.reused }
}
