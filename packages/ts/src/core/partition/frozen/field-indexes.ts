import { bitsetSet, createBitSet } from '../../bitset'
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
  }
}

export function createFrozenBooleanReader(entry: SegmentPayload['boolean'][number]): BooleanFieldIndexReader {
  const { trueDocs, falseDocs } = entry
  return {
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
  }
}
