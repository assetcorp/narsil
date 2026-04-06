import { bitsetAnd, bitsetNot, bitsetOr } from '../core/bitset'

export function applyAndBitset(bitsets: Uint32Array[]): Uint32Array {
  if (bitsets.length === 0) return new Uint32Array(0)
  if (bitsets.length === 1) return bitsets[0]

  let result = bitsets[0]
  for (let i = 1; i < bitsets.length; i++) {
    result = bitsetAnd(result, bitsets[i])
  }
  return result
}

export function applyOrBitset(bitsets: Uint32Array[]): Uint32Array {
  if (bitsets.length === 0) return new Uint32Array(0)
  if (bitsets.length === 1) return bitsets[0]

  let result = bitsets[0]
  for (let i = 1; i < bitsets.length; i++) {
    result = bitsetOr(result, bitsets[i])
  }
  return result
}

export function applyNotBitset(excluded: Uint32Array, capacity: number): Uint32Array {
  return bitsetNot(excluded, capacity)
}

export function applyAnd(sets: Set<number>[]): Set<number> {
  if (sets.length === 0) return new Set()
  if (sets.length === 1) return sets[0]

  const sorted = [...sets].sort((a, b) => a.size - b.size)
  let result = sorted[0]

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]
    const intersection = new Set<number>()
    for (const item of result) {
      if (next.has(item)) intersection.add(item)
    }
    result = intersection
    if (result.size === 0) break
  }

  return result
}

export function applyOr(sets: Set<number>[]): Set<number> {
  if (sets.length === 0) return new Set()
  if (sets.length === 1) return sets[0]

  const result = new Set<number>()
  for (const set of sets) {
    for (const item of set) {
      result.add(item)
    }
  }
  return result
}

export function applyNot(universe: Set<number>, excluded: Set<number>): Set<number> {
  const result = new Set<number>()
  for (const item of universe) {
    if (!excluded.has(item)) result.add(item)
  }
  return result
}
