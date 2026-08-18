import { bitsetHas, bitsetSet, createBitSet } from '../../bitset'
import type { BooleanFieldIndexReader, EnumFieldIndexReader, NumericFieldIndexReader } from '../../field-index'
import type { SegmentPayload } from '../segment-payload'

function lowerBound(values: Float64Array, value: number): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (values[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound(values: Float64Array, value: number): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (values[mid] <= value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function setOfRange(docIds: Uint32Array, from: number, to: number): Set<number> {
  const result = new Set<number>()
  for (let i = from; i < to; i++) result.add(docIds[i])
  return result
}

function setOutsideRange(docIds: Uint32Array, from: number, to: number): Set<number> {
  const result = new Set<number>()
  for (let i = 0; i < from; i++) result.add(docIds[i])
  for (let i = to; i < docIds.length; i++) result.add(docIds[i])
  return result
}

function bitsetOfRange(docIds: Uint32Array, from: number, to: number, capacity: number): Uint32Array {
  const bits = createBitSet(capacity)
  for (let i = from; i < to; i++) bitsetSet(bits, docIds[i])
  return bits
}

export function createFrozenNumericReader(entry: SegmentPayload['numeric'][number]): NumericFieldIndexReader {
  const { docIds, values } = entry
  return {
    serialize: () => Array.from(docIds, (docId, i) => ({ docId, value: values[i] })),
    queryEq: value => setOfRange(docIds, lowerBound(values, value), upperBound(values, value)),
    queryNe: value => setOutsideRange(docIds, lowerBound(values, value), upperBound(values, value)),
    queryGt: value => setOfRange(docIds, upperBound(values, value), docIds.length),
    queryGte: value => setOfRange(docIds, lowerBound(values, value), docIds.length),
    queryLt: value => setOfRange(docIds, 0, lowerBound(values, value)),
    queryLte: value => setOfRange(docIds, 0, upperBound(values, value)),
    queryBetween: (min, max) => setOfRange(docIds, lowerBound(values, min), upperBound(values, max)),
    getAllDocIds: () => setOfRange(docIds, 0, docIds.length),
    queryEqBitset: (value, capacity) =>
      bitsetOfRange(docIds, lowerBound(values, value), upperBound(values, value), capacity),
    queryGtBitset: (value, capacity) => bitsetOfRange(docIds, upperBound(values, value), docIds.length, capacity),
    queryGteBitset: (value, capacity) => bitsetOfRange(docIds, lowerBound(values, value), docIds.length, capacity),
    queryLtBitset: (value, capacity) => bitsetOfRange(docIds, 0, lowerBound(values, value), capacity),
    queryLteBitset: (value, capacity) => bitsetOfRange(docIds, 0, upperBound(values, value), capacity),
    queryBetweenBitset: (min, max, capacity) =>
      bitsetOfRange(docIds, lowerBound(values, min), upperBound(values, max), capacity),
    getAllDocIdsBitset: capacity => bitsetOfRange(docIds, 0, docIds.length, capacity),
    count: () => docIds.length,
    facetValueCounts: matched => {
      const counts = new Map<number, number>()
      let i = 0
      while (i < values.length) {
        const value = values[i]
        let runEnd = i + 1
        while (runEnd < values.length && values[runEnd] === value) runEnd++
        if (runEnd - i === 1) {
          if (bitsetHas(matched, docIds[i])) counts.set(value, 1)
        } else {
          const seen = new Set<number>()
          for (let j = i; j < runEnd; j++) {
            if (bitsetHas(matched, docIds[j])) seen.add(docIds[j])
          }
          if (seen.size > 0) counts.set(value, seen.size)
        }
        i = runEnd
      }
      return counts
    },
    facetRangeCount: (from, to, matched) => {
      const start = lowerBound(values, from)
      const end = lowerBound(values, to)
      const seen = new Set<number>()
      for (let i = start; i < end; i++) {
        if (bitsetHas(matched, docIds[i])) seen.add(docIds[i])
      }
      return seen.size
    },
  }
}

export function createFrozenBooleanReader(entry: SegmentPayload['boolean'][number]): BooleanFieldIndexReader {
  const { trueDocs, falseDocs } = entry
  return {
    serialize: () => ({ trueDocs: [...trueDocs], falseDocs: [...falseDocs] }),
    queryEq: value => setOfRange(value ? trueDocs : falseDocs, 0, value ? trueDocs.length : falseDocs.length),
    queryNe: value => setOfRange(value ? falseDocs : trueDocs, 0, value ? falseDocs.length : trueDocs.length),
    getAllDocIds: () => {
      const all = setOfRange(trueDocs, 0, trueDocs.length)
      for (let i = 0; i < falseDocs.length; i++) all.add(falseDocs[i])
      return all
    },
    queryEqBitset: (value, capacity) =>
      bitsetOfRange(value ? trueDocs : falseDocs, 0, value ? trueDocs.length : falseDocs.length, capacity),
    getAllDocIdsBitset: capacity => {
      const bits = bitsetOfRange(trueDocs, 0, trueDocs.length, capacity)
      for (let i = 0; i < falseDocs.length; i++) bitsetSet(bits, falseDocs[i])
      return bits
    },
    count: () => trueDocs.length + falseDocs.length,
    facetCounts: matched => {
      let trueCount = 0
      let falseCount = 0
      for (let i = 0; i < trueDocs.length; i++) {
        if (bitsetHas(matched, trueDocs[i])) trueCount++
      }
      for (let i = 0; i < falseDocs.length; i++) {
        if (bitsetHas(matched, falseDocs[i])) falseCount++
      }
      return { trueCount, falseCount }
    },
  }
}

export function createFrozenEnumReader(entry: SegmentPayload['enums'][number]): EnumFieldIndexReader {
  const { values, offsets, docIds } = entry
  const rangeByValue = new Map<string, { from: number; to: number }>()
  for (let i = 0; i < values.length; i++) {
    rangeByValue.set(values[i], { from: offsets[i], to: offsets[i + 1] })
  }

  function rangeOf(value: string): { from: number; to: number } {
    return rangeByValue.get(value) ?? { from: 0, to: 0 }
  }

  return {
    serialize: () => {
      const byValue: Record<string, number[]> = Object.create(null)
      for (let i = 0; i < values.length; i++) {
        byValue[values[i]] = [...docIds.subarray(offsets[i], offsets[i + 1])]
      }
      return byValue
    },
    queryEq: value => {
      const { from, to } = rangeOf(value)
      return setOfRange(docIds, from, to)
    },
    queryNe: value => {
      const { from, to } = rangeOf(value)
      return setOutsideRange(docIds, from, to)
    },
    queryIn: requested => {
      const result = new Set<number>()
      for (const value of requested) {
        const { from, to } = rangeOf(value)
        for (let i = from; i < to; i++) result.add(docIds[i])
      }
      return result
    },
    queryNin: excluded => {
      const excludedSet = new Set<number>()
      for (const value of excluded) {
        const { from, to } = rangeOf(value)
        for (let i = from; i < to; i++) excludedSet.add(docIds[i])
      }
      const result = new Set<number>()
      for (let i = 0; i < docIds.length; i++) {
        if (!excludedSet.has(docIds[i])) result.add(docIds[i])
      }
      return result
    },
    getAllDocIds: () => setOfRange(docIds, 0, docIds.length),
    queryEqBitset: (value, capacity) => {
      const { from, to } = rangeOf(value)
      return bitsetOfRange(docIds, from, to, capacity)
    },
    queryInBitset: (requested, capacity) => {
      const bits = createBitSet(capacity)
      for (const value of requested) {
        const { from, to } = rangeOf(value)
        for (let i = from; i < to; i++) bitsetSet(bits, docIds[i])
      }
      return bits
    },
    getAllDocIdsBitset: capacity => bitsetOfRange(docIds, 0, docIds.length, capacity),
    count: () => docIds.length,
    facetCounts: matched => {
      const counts = new Map<string, number>()
      for (let i = 0; i < values.length; i++) {
        let count = 0
        for (let j = offsets[i]; j < offsets[i + 1]; j++) {
          if (bitsetHas(matched, docIds[j])) count++
        }
        if (count > 0) counts.set(values[i], count)
      }
      return counts
    },
  }
}
