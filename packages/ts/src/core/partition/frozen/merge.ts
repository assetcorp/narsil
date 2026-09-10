import { encode } from '@msgpack/msgpack'
import type { SerializedSurfaceForms } from '../../../types/internal'
import { createSurfaceRegistry } from '../../surface-registry'
import type { SegmentPayload } from '../segment-payload'
import type { EncodedDocumentTableData } from './document-source'
import type { FrozenSegment } from './index'
import { mergeFieldIndexes } from './merge-fields'
import { mergePostings, type SegmentRemap } from './merge-postings'
import { freezeEncodedSegmentShared, type SharedSegmentSnapshot } from './shared-snapshot'

function remapOf(segment: FrozenSegment, docIds: string[]): Int32Array {
  const count = segment.arrays.documentCount
  const remap = new Int32Array(count).fill(-1)
  for (let ordinal = 0; ordinal < count; ordinal++) {
    if (segment.isTombstoned(ordinal)) continue
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

function fieldIndexRemapOf(segment: FrozenSegment, fieldNames: string[]): Uint8Array {
  const remap = new Uint8Array(segment.arrays.fieldNames.length)
  for (let i = 0; i < segment.arrays.fieldNames.length; i++) {
    remap[i] = fieldNameIndex(fieldNames, segment.arrays.fieldNames[i])
  }
  return remap
}

function mergeFieldLengths(
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

function mergeSurfaceForms(inputs: readonly SegmentRemap[]): SerializedSurfaceForms | null {
  const registry = createSurfaceRegistry()
  for (const input of inputs) {
    const forms = input.segment.arrays.surfaceForms
    if (forms === null) continue
    for (const surface of Object.keys(forms)) {
      const value = forms[surface]
      if (Array.isArray(value)) registry.add(surface, value[1], value[0])
    }
  }
  return registry.size() === 0 ? null : registry.serialize()
}

function encodedDocumentsOf(input: SegmentRemap): (ordinal: number) => Uint8Array {
  const table = input.segment.arrays.documentTable
  if (table !== null) {
    return ordinal => table.blob.subarray(table.offsets[ordinal], table.offsets[ordinal + 1])
  }
  const encoded: Array<Uint8Array | undefined> = new Array(input.remap.length)
  return ordinal => {
    let bytes = encoded[ordinal]
    if (bytes === undefined) {
      bytes = encode(input.segment.documentSource.docAt(ordinal))
      encoded[ordinal] = bytes
    }
    return bytes
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

/**
 * Merges frozen segments into one shared segment by copying their flat
 * arrays, so the merge holds the inputs and one output alone.
 *
 * Every surviving document keeps its postings, field lengths, field index
 * entries, and encoded bytes, so a query over the merged segment scores each
 * document as it did over the inputs.
 *
 * @param segments The segments to merge, in the order their documents take.
 * @returns The merged segment, or null where the runtime offers no shared memory.
 *
 * @internal
 */
export function mergeFrozenSegments(segments: readonly FrozenSegment[]): SharedSegmentSnapshot | null {
  if (typeof SharedArrayBuffer !== 'function') return null

  const docIds: string[] = []
  const fieldNames: string[] = []
  const inputs: SegmentRemap[] = segments.map(segment => ({
    segment,
    remap: remapOf(segment, docIds),
    fieldIndexRemap: fieldIndexRemapOf(segment, fieldNames),
  }))
  const documentCount = docIds.length
  const postings = mergePostings(inputs)
  const lengths = mergeFieldLengths(inputs, documentCount)

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
    surfaceForms: mergeSurfaceForms(inputs),
    ...mergeFieldIndexes(inputs),
  }

  return freezeEncodedSegmentShared(payload, mergeDocuments(inputs, documentCount))
}
