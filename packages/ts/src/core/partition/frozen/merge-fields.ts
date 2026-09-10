import { compareCodePoints } from '../../ordering'
import type { SegmentPayload } from '../segment-payload'
import type { SegmentRemap } from './merge-postings'

type FieldIndexes = Pick<SegmentPayload, 'numeric' | 'boolean' | 'enums' | 'geo'>

function survivors(remap: Int32Array, docIds: Uint32Array): number {
  let count = 0
  for (let i = 0; i < docIds.length; i++) {
    if (remap[docIds[i]] >= 0) count += 1
  }
  return count
}

function mergeNumeric(inputs: readonly SegmentRemap[]): SegmentPayload['numeric'] {
  const byField = new Map<string, Array<{ docId: number; value: number }>>()
  for (const input of inputs) {
    for (const entry of input.segment.arrays.numeric) {
      let entries = byField.get(entry.fieldPath)
      if (entries === undefined) {
        entries = []
        byField.set(entry.fieldPath, entries)
      }
      for (let i = 0; i < entry.docIds.length; i++) {
        const target = input.remap[entry.docIds[i]]
        if (target < 0) continue
        entries.push({ docId: target, value: entry.values[i] })
      }
    }
  }
  const merged: SegmentPayload['numeric'] = []
  for (const [fieldPath, entries] of byField) {
    entries.sort((a, b) => a.value - b.value || a.docId - b.docId)
    const docIds = new Uint32Array(entries.length)
    const values = new Float64Array(entries.length)
    for (let i = 0; i < entries.length; i++) {
      docIds[i] = entries[i].docId
      values[i] = entries[i].value
    }
    merged.push({ fieldPath, docIds, values })
  }
  return merged
}

function remapped(
  inputs: readonly SegmentRemap[],
  pick: (input: SegmentRemap) => Uint32Array | undefined,
): Uint32Array {
  let total = 0
  for (const input of inputs) {
    const docIds = pick(input)
    if (docIds !== undefined) total += survivors(input.remap, docIds)
  }
  const out = new Uint32Array(total)
  let cursor = 0
  for (const input of inputs) {
    const docIds = pick(input)
    if (docIds === undefined) continue
    for (let i = 0; i < docIds.length; i++) {
      const target = input.remap[docIds[i]]
      if (target >= 0) out[cursor++] = target
    }
  }
  return out
}

function mergeBoolean(inputs: readonly SegmentRemap[]): SegmentPayload['boolean'] {
  const fieldPaths: string[] = []
  for (const input of inputs) {
    for (const entry of input.segment.arrays.boolean) {
      if (!fieldPaths.includes(entry.fieldPath)) fieldPaths.push(entry.fieldPath)
    }
  }
  return fieldPaths.map(fieldPath => ({
    fieldPath,
    trueDocs: remapped(inputs, input => input.segment.arrays.boolean.find(e => e.fieldPath === fieldPath)?.trueDocs),
    falseDocs: remapped(inputs, input => input.segment.arrays.boolean.find(e => e.fieldPath === fieldPath)?.falseDocs),
  }))
}

function mergeEnums(inputs: readonly SegmentRemap[]): SegmentPayload['enums'] {
  const valuesByField = new Map<string, Set<string>>()
  for (const input of inputs) {
    for (const entry of input.segment.arrays.enums) {
      let values = valuesByField.get(entry.fieldPath)
      if (values === undefined) {
        values = new Set()
        valuesByField.set(entry.fieldPath, values)
      }
      for (const value of entry.values) values.add(value)
    }
  }
  const merged: SegmentPayload['enums'] = []
  for (const [fieldPath, valueSet] of valuesByField) {
    const values = [...valueSet].sort(compareCodePoints)
    const perValue = values.map(value =>
      remapped(inputs, input => {
        const entry = input.segment.arrays.enums.find(e => e.fieldPath === fieldPath)
        if (entry === undefined) return undefined
        const at = entry.values.indexOf(value)
        return at < 0 ? undefined : entry.docIds.subarray(entry.offsets[at], entry.offsets[at + 1])
      }),
    )
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

function mergeGeo(inputs: readonly SegmentRemap[]): SegmentPayload['geo'] {
  const byField = new Map<string, Array<{ docId: number; lat: number; lon: number }>>()
  for (const input of inputs) {
    for (const entry of input.segment.arrays.geo) {
      let entries = byField.get(entry.fieldPath)
      if (entries === undefined) {
        entries = []
        byField.set(entry.fieldPath, entries)
      }
      for (let i = 0; i < entry.docIds.length; i++) {
        const target = input.remap[entry.docIds[i]]
        if (target < 0) continue
        entries.push({ docId: target, lat: entry.latitudes[i], lon: entry.longitudes[i] })
      }
    }
  }
  const merged: SegmentPayload['geo'] = []
  for (const [fieldPath, entries] of byField) {
    const docIds = new Uint32Array(entries.length)
    const latitudes = new Float64Array(entries.length)
    const longitudes = new Float64Array(entries.length)
    for (let i = 0; i < entries.length; i++) {
      docIds[i] = entries[i].docId
      latitudes[i] = entries[i].lat
      longitudes[i] = entries[i].lon
    }
    merged.push({ fieldPath, docIds, latitudes, longitudes })
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
