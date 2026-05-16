import { bitsetAnd, bitsetFromSet, bitsetNot, bitsetSet, createBitSet } from '../../core/bitset'
import type { ComparisonFilter } from '../../types/filters'
import {
  convertToMeters,
  type FieldIndex,
  type GeoFieldIndex,
  type GetFieldValue,
  matchesNumericComparison,
} from './shared'

function resolveBitset(bs: (() => Uint32Array) | Uint32Array): Uint32Array {
  return typeof bs === 'function' ? bs() : bs
}

function scanToBitset(
  docIds: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
  predicate: (v: unknown) => boolean,
): Uint32Array {
  const resolved = resolveBitset(docIds)
  const result = createBitSet(capacity)
  for (let wi = 0; wi < resolved.length; wi++) {
    let word = resolved[wi]
    if (word === 0) continue
    const base = wi << 5
    while (word !== 0) {
      const tz = Math.clz32(word & -word) ^ 31
      const id = base + tz
      if (predicate(getValue(id))) {
        bitsetSet(result, id)
      }
      word &= word - 1
    }
  }
  return result
}

export function applyEqBitset(
  value: number | string | boolean,
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Uint32Array {
  if (fieldIndex?.type === 'numeric' && typeof value === 'number') {
    return fieldIndex.index.eqBitset(value, capacity)
  }
  if (fieldIndex?.type === 'boolean' && typeof value === 'boolean') {
    return value ? fieldIndex.index.getTrueBitset(capacity) : fieldIndex.index.getFalseBitset(capacity)
  }
  if (fieldIndex?.type === 'enum' && typeof value === 'string') {
    return fieldIndex.index.getDocIdsBitset(value, capacity)
  }
  return scanToBitset(allDocsBitset, capacity, getValue, v => v === value)
}

export function applyNeBitset(
  value: number | string | boolean,
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Uint32Array {
  if (fieldIndex?.type === 'numeric' && typeof value === 'number') {
    const all = fieldIndex.index.allDocIdsBitset(capacity)
    const eq = fieldIndex.index.eqBitset(value, capacity)
    return bitsetAnd(all, bitsetNot(eq, capacity))
  }
  if (fieldIndex?.type === 'boolean' && typeof value === 'boolean') {
    return value ? fieldIndex.index.getFalseBitset(capacity) : fieldIndex.index.getTrueBitset(capacity)
  }
  if (fieldIndex?.type === 'enum' && typeof value === 'string') {
    const all = fieldIndex.index.allDocIdsBitset(capacity)
    const eq = fieldIndex.index.getDocIdsBitset(value, capacity)
    return bitsetAnd(all, bitsetNot(eq, capacity))
  }
  return scanToBitset(allDocsBitset, capacity, getValue, v => v !== undefined && v !== null && v !== value)
}

export function applyGtBitset(
  value: number,
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Uint32Array {
  if (fieldIndex?.type === 'numeric') {
    return fieldIndex.index.gtBitset(value, capacity)
  }
  return scanToBitset(allDocsBitset, capacity, getValue, v => typeof v === 'number' && v > value)
}

export function applyLtBitset(
  value: number,
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Uint32Array {
  if (fieldIndex?.type === 'numeric') {
    return fieldIndex.index.ltBitset(value, capacity)
  }
  return scanToBitset(allDocsBitset, capacity, getValue, v => typeof v === 'number' && v < value)
}

export function applyGteBitset(
  value: number,
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Uint32Array {
  if (fieldIndex?.type === 'numeric') {
    return fieldIndex.index.gteBitset(value, capacity)
  }
  return scanToBitset(allDocsBitset, capacity, getValue, v => typeof v === 'number' && v >= value)
}

export function applyLteBitset(
  value: number,
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Uint32Array {
  if (fieldIndex?.type === 'numeric') {
    return fieldIndex.index.lteBitset(value, capacity)
  }
  return scanToBitset(allDocsBitset, capacity, getValue, v => typeof v === 'number' && v <= value)
}

export function applyBetweenBitset(
  range: [number, number],
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Uint32Array {
  if (fieldIndex?.type === 'numeric') {
    return fieldIndex.index.betweenBitset(range[0], range[1], capacity)
  }
  return scanToBitset(allDocsBitset, capacity, getValue, v => typeof v === 'number' && v >= range[0] && v <= range[1])
}

export function applyInBitset(
  values: string[],
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Uint32Array {
  if (fieldIndex?.type === 'enum') {
    return fieldIndex.index.getDocIdsInBitset(values, capacity)
  }
  const valSet = new Set<string>(values)
  return scanToBitset(allDocsBitset, capacity, getValue, v => typeof v === 'string' && valSet.has(v))
}

export function applyNinBitset(
  values: string[],
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Uint32Array {
  if (fieldIndex?.type === 'enum') {
    const all = fieldIndex.index.allDocIdsBitset(capacity)
    const matched = fieldIndex.index.getDocIdsInBitset(values, capacity)
    return bitsetAnd(all, bitsetNot(matched, capacity))
  }
  const valSet = new Set<string>(values)
  return scanToBitset(
    allDocsBitset,
    capacity,
    getValue,
    v => v !== undefined && v !== null && typeof v === 'string' && !valSet.has(v),
  )
}

export function applyStartsWithBitset(
  prefix: string,
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
): Uint32Array {
  return scanToBitset(allDocsBitset, capacity, getValue, v => typeof v === 'string' && v.startsWith(prefix))
}

export function applyEndsWithBitset(
  suffix: string,
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
): Uint32Array {
  return scanToBitset(allDocsBitset, capacity, getValue, v => typeof v === 'string' && v.endsWith(suffix))
}

export function applyContainsAllBitset(
  values: (string | number | boolean)[],
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
): Uint32Array {
  return scanToBitset(allDocsBitset, capacity, getValue, v => {
    if (!Array.isArray(v)) return false
    const arr = v as unknown[]
    for (const val of values) {
      if (!arr.includes(val)) return false
    }
    return true
  })
}

export function applyMatchesAnyBitset(
  values: (string | number | boolean)[],
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
): Uint32Array {
  const valSet = new Set<unknown>(values)
  return scanToBitset(allDocsBitset, capacity, getValue, v => {
    if (!Array.isArray(v)) return false
    for (const item of v as unknown[]) {
      if (valSet.has(item)) return true
    }
    return false
  })
}

export function applySizeBitset(
  sizeFilter: ComparisonFilter,
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
): Uint32Array {
  return scanToBitset(
    allDocsBitset,
    capacity,
    getValue,
    v => Array.isArray(v) && matchesNumericComparison(v.length, sizeFilter),
  )
}

export function applyExistsBitset(
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
): Uint32Array {
  return scanToBitset(allDocsBitset, capacity, getValue, v => v !== undefined && v !== null)
}

export function applyNotExistsBitset(
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
): Uint32Array {
  return scanToBitset(allDocsBitset, capacity, getValue, v => v === undefined || v === null)
}

export function applyIsEmptyBitset(
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
): Uint32Array {
  return scanToBitset(allDocsBitset, capacity, getValue, v => {
    if (v === undefined || v === null) return true
    if (typeof v === 'string' && v === '') return true
    if (Array.isArray(v) && v.length === 0) return true
    return false
  })
}

export function applyIsNotEmptyBitset(
  allDocsBitset: (() => Uint32Array) | Uint32Array,
  capacity: number,
  getValue: GetFieldValue,
): Uint32Array {
  return scanToBitset(allDocsBitset, capacity, getValue, v => {
    if (v === undefined || v === null) return false
    if (typeof v === 'string' && v === '') return false
    if (Array.isArray(v) && v.length === 0) return false
    return true
  })
}

export function applyGeoRadiusBitset(
  filter: {
    lat: number
    lon: number
    distance: number
    unit: 'km' | 'mi' | 'm'
    inside?: boolean
    highPrecision?: boolean
  },
  geoIndex: GeoFieldIndex,
  capacity: number,
): Uint32Array {
  const distanceMeters = convertToMeters(filter.distance, filter.unit)
  const setResult = geoIndex.radiusQuery(
    filter.lat,
    filter.lon,
    distanceMeters,
    filter.inside ?? true,
    filter.highPrecision ?? false,
  )
  return bitsetFromSet(setResult, capacity)
}

export function applyGeoPolygonBitset(
  filter: { points: Array<{ lat: number; lon: number }>; inside?: boolean },
  geoIndex: GeoFieldIndex,
  capacity: number,
): Uint32Array {
  const setResult = geoIndex.polygonQuery(filter.points, filter.inside ?? true)
  return bitsetFromSet(setResult, capacity)
}
