import { compareCodePoints } from '../../ordering'
import type { SegmentPayload } from '../segment-payload'
import type { SegmentRemap } from './merge-postings'

type FieldIndexes = Pick<SegmentPayload, 'numeric' | 'boolean' | 'enums' | 'geo'>

interface RemappedRow {
  docId: number
  values: number[]
}

function indexByFieldPath<Entry extends { fieldPath: string }>(entries: readonly Entry[]): Map<string, Entry> {
  const byFieldPath = new Map<string, Entry>()
  for (const entry of entries) byFieldPath.set(entry.fieldPath, entry)
  return byFieldPath
}

function rowsByFieldPath<Entry extends { fieldPath: string; docIds: Uint32Array }>(
  inputs: readonly SegmentRemap[],
  entriesOf: (input: SegmentRemap) => readonly Entry[],
  valuesOf: (entry: Entry, at: number) => number[],
): Map<string, RemappedRow[]> {
  const byFieldPath = new Map<string, RemappedRow[]>()
  for (const input of inputs) {
    for (const entry of entriesOf(input)) {
      let rows = byFieldPath.get(entry.fieldPath)
      if (rows === undefined) {
        rows = []
        byFieldPath.set(entry.fieldPath, rows)
      }
      for (let i = 0; i < entry.docIds.length; i++) {
        const docId = input.remap[entry.docIds[i]]
        if (docId < 0) continue
        rows.push({ docId, values: valuesOf(entry, i) })
      }
    }
  }
  return byFieldPath
}

function docIdColumn(rows: readonly RemappedRow[]): Uint32Array {
  const docIds = new Uint32Array(rows.length)
  for (let i = 0; i < rows.length; i++) docIds[i] = rows[i].docId
  return docIds
}

function valueColumn(rows: readonly RemappedRow[], column: number): Float64Array {
  const values = new Float64Array(rows.length)
  for (let i = 0; i < rows.length; i++) values[i] = rows[i].values[column]
  return values
}

function remapDocIds(inputs: readonly SegmentRemap[], pick: (at: number) => Uint32Array | undefined): Uint32Array {
  let total = 0
  for (let at = 0; at < inputs.length; at++) {
    const docIds = pick(at)
    if (docIds === undefined) continue
    for (let i = 0; i < docIds.length; i++) {
      if (inputs[at].remap[docIds[i]] >= 0) total += 1
    }
  }
  const out = new Uint32Array(total)
  let cursor = 0
  for (let at = 0; at < inputs.length; at++) {
    const docIds = pick(at)
    if (docIds === undefined) continue
    for (let i = 0; i < docIds.length; i++) {
      const target = inputs[at].remap[docIds[i]]
      if (target >= 0) out[cursor++] = target
    }
  }
  return out
}

function mergeNumeric(inputs: readonly SegmentRemap[]): SegmentPayload['numeric'] {
  const byFieldPath = rowsByFieldPath(
    inputs,
    input => input.segment.arrays.numeric,
    (entry, at) => [entry.values[at]],
  )
  const merged: SegmentPayload['numeric'] = []
  for (const [fieldPath, rows] of byFieldPath) {
    rows.sort((a, b) => a.values[0] - b.values[0] || a.docId - b.docId)
    merged.push({ fieldPath, docIds: docIdColumn(rows), values: valueColumn(rows, 0) })
  }
  return merged
}

function mergeGeo(inputs: readonly SegmentRemap[]): SegmentPayload['geo'] {
  const byFieldPath = rowsByFieldPath(
    inputs,
    input => input.segment.arrays.geo,
    (entry, at) => [entry.latitudes[at], entry.longitudes[at]],
  )
  const merged: SegmentPayload['geo'] = []
  for (const [fieldPath, rows] of byFieldPath) {
    merged.push({
      fieldPath,
      docIds: docIdColumn(rows),
      latitudes: valueColumn(rows, 0),
      longitudes: valueColumn(rows, 1),
    })
  }
  return merged
}

function mergeBoolean(inputs: readonly SegmentRemap[]): SegmentPayload['boolean'] {
  const perInput = inputs.map(input => indexByFieldPath(input.segment.arrays.boolean))
  const fieldPaths: string[] = []
  for (const index of perInput) {
    for (const fieldPath of index.keys()) {
      if (!fieldPaths.includes(fieldPath)) fieldPaths.push(fieldPath)
    }
  }
  return fieldPaths.map(fieldPath => ({
    fieldPath,
    trueDocs: remapDocIds(inputs, at => perInput[at].get(fieldPath)?.trueDocs),
    falseDocs: remapDocIds(inputs, at => perInput[at].get(fieldPath)?.falseDocs),
  }))
}

function enumDocIds(entry: SegmentPayload['enums'][number] | undefined, value: string): Uint32Array | undefined {
  if (entry === undefined) return undefined
  const at = entry.values.indexOf(value)
  return at < 0 ? undefined : entry.docIds.subarray(entry.offsets[at], entry.offsets[at + 1])
}

function mergeEnums(inputs: readonly SegmentRemap[]): SegmentPayload['enums'] {
  const perInput = inputs.map(input => indexByFieldPath(input.segment.arrays.enums))
  const valuesByFieldPath = new Map<string, Set<string>>()
  for (const index of perInput) {
    for (const [fieldPath, entry] of index) {
      let values = valuesByFieldPath.get(fieldPath)
      if (values === undefined) {
        values = new Set()
        valuesByFieldPath.set(fieldPath, values)
      }
      for (const value of entry.values) values.add(value)
    }
  }
  const merged: SegmentPayload['enums'] = []
  for (const [fieldPath, valueSet] of valuesByFieldPath) {
    const values = [...valueSet].sort(compareCodePoints)
    const perValue = values.map(value => remapDocIds(inputs, at => enumDocIds(perInput[at].get(fieldPath), value)))
    const offsets = new Uint32Array(values.length + 1)
    let total = 0
    for (let i = 0; i < values.length; i++) {
      total += perValue[i].length
      offsets[i + 1] = total
    }
    const docIds = new Uint32Array(total)
    for (let i = 0; i < values.length; i++) docIds.set(perValue[i], offsets[i])
    merged.push({ fieldPath, values, offsets, docIds })
  }
  return merged
}

/**
 * Merges the numeric, boolean, enum, and geo field indexes of several frozen
 * segments, remapping every document ordinal and dropping tombstoned ones.
 *
 * @param inputs The segments to merge with their ordinal remaps.
 * @returns The merged field indexes.
 *
 * @internal
 */
export function mergeFieldIndexes(inputs: readonly SegmentRemap[]): FieldIndexes {
  return {
    numeric: mergeNumeric(inputs),
    boolean: mergeBoolean(inputs),
    enums: mergeEnums(inputs),
    geo: mergeGeo(inputs),
  }
}
