import type { ComparisonFilter } from '../types/filters'

export type GetFieldValue = (internalId: number) => unknown

export interface NumericFieldIndex {
  eq(value: number): Set<number>
  gt(value: number): Set<number>
  gte(value: number): Set<number>
  lt(value: number): Set<number>
  lte(value: number): Set<number>
  between(min: number, max: number): Set<number>
  allDocIds(): Set<number>
}

export interface BooleanFieldIndex {
  getTrue(): Set<number>
  getFalse(): Set<number>
  allDocIds(): Set<number>
}

export interface EnumFieldIndex {
  getDocIds(value: string): Set<number>
  allDocIds(): Set<number>
}

export interface GeoFieldIndex {
  radiusQuery(lat: number, lon: number, distanceMeters: number, inside: boolean, highPrecision: boolean): Set<number>
  polygonQuery(points: Array<{ lat: number; lon: number }>, inside: boolean): Set<number>
}

export type FieldIndex =
  | { type: 'numeric'; index: NumericFieldIndex }
  | { type: 'boolean'; index: BooleanFieldIndex }
  | { type: 'enum'; index: EnumFieldIndex }
  | { type: 'geopoint'; index: GeoFieldIndex }

const METERS_PER_KM = 1000
const METERS_PER_MI = 1609.344

export function convertToMeters(distance: number, unit: 'km' | 'mi' | 'm'): number {
  if (unit === 'km') return distance * METERS_PER_KM
  if (unit === 'mi') return distance * METERS_PER_MI
  return distance
}

function setDifference(a: Set<number>, b: Set<number>): Set<number> {
  const result = new Set<number>()
  for (const item of a) {
    if (!b.has(item)) result.add(item)
  }
  return result
}

export function applyEq(
  value: number | string | boolean,
  docIds: Set<number>,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Set<number> {
  if (fieldIndex?.type === 'numeric' && typeof value === 'number') {
    return fieldIndex.index.eq(value)
  }
  if (fieldIndex?.type === 'boolean' && typeof value === 'boolean') {
    return value ? fieldIndex.index.getTrue() : fieldIndex.index.getFalse()
  }
  if (fieldIndex?.type === 'enum' && typeof value === 'string') {
    return fieldIndex.index.getDocIds(value)
  }
  const result = new Set<number>()
  for (const id of docIds) {
    if (getValue(id) === value) result.add(id)
  }
  return result
}

export function applyNe(
  value: number | string | boolean,
  docIds: Set<number>,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Set<number> {
  if (fieldIndex?.type === 'numeric' && typeof value === 'number') {
    return setDifference(fieldIndex.index.allDocIds(), fieldIndex.index.eq(value))
  }
  if (fieldIndex?.type === 'boolean' && typeof value === 'boolean') {
    return value ? fieldIndex.index.getFalse() : fieldIndex.index.getTrue()
  }
  if (fieldIndex?.type === 'enum' && typeof value === 'string') {
    return setDifference(fieldIndex.index.allDocIds(), fieldIndex.index.getDocIds(value))
  }
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (v !== undefined && v !== null && v !== value) result.add(id)
  }
  return result
}

export function applyGt(
  value: number,
  docIds: Set<number>,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Set<number> {
  if (fieldIndex?.type === 'numeric') {
    return fieldIndex.index.gt(value)
  }
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (typeof v === 'number' && v > value) result.add(id)
  }
  return result
}

export function applyLt(
  value: number,
  docIds: Set<number>,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Set<number> {
  if (fieldIndex?.type === 'numeric') {
    return fieldIndex.index.lt(value)
  }
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (typeof v === 'number' && v < value) result.add(id)
  }
  return result
}

export function applyGte(
  value: number,
  docIds: Set<number>,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Set<number> {
  if (fieldIndex?.type === 'numeric') {
    return fieldIndex.index.gte(value)
  }
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (typeof v === 'number' && v >= value) result.add(id)
  }
  return result
}

export function applyLte(
  value: number,
  docIds: Set<number>,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Set<number> {
  if (fieldIndex?.type === 'numeric') {
    return fieldIndex.index.lte(value)
  }
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (typeof v === 'number' && v <= value) result.add(id)
  }
  return result
}

export function applyBetween(
  range: [number, number],
  docIds: Set<number>,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Set<number> {
  if (fieldIndex?.type === 'numeric') {
    return fieldIndex.index.between(range[0], range[1])
  }
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (typeof v === 'number' && v >= range[0] && v <= range[1]) result.add(id)
  }
  return result
}

export function applyIn(
  values: string[],
  docIds: Set<number>,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Set<number> {
  if (fieldIndex?.type === 'enum') {
    const result = new Set<number>()
    for (const val of values) {
      for (const id of fieldIndex.index.getDocIds(val)) {
        result.add(id)
      }
    }
    return result
  }
  const valSet = new Set<string>(values)
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (typeof v === 'string' && valSet.has(v)) result.add(id)
  }
  return result
}

export function applyNin(
  values: string[],
  docIds: Set<number>,
  getValue: GetFieldValue,
  fieldIndex?: FieldIndex,
): Set<number> {
  if (fieldIndex?.type === 'enum') {
    const matched = new Set<number>()
    for (const val of values) {
      for (const id of fieldIndex.index.getDocIds(val)) {
        matched.add(id)
      }
    }
    return setDifference(fieldIndex.index.allDocIds(), matched)
  }
  const valSet = new Set<string>(values)
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (v !== undefined && v !== null && typeof v === 'string' && !valSet.has(v)) result.add(id)
  }
  return result
}

export function applyStartsWith(prefix: string, docIds: Set<number>, getValue: GetFieldValue): Set<number> {
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (typeof v === 'string' && v.startsWith(prefix)) result.add(id)
  }
  return result
}

export function applyEndsWith(suffix: string, docIds: Set<number>, getValue: GetFieldValue): Set<number> {
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (typeof v === 'string' && v.endsWith(suffix)) result.add(id)
  }
  return result
}

export function applyContainsAll(
  values: (string | number | boolean)[],
  docIds: Set<number>,
  getValue: GetFieldValue,
): Set<number> {
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (!Array.isArray(v)) continue
    const arr = v as unknown[]
    let allFound = true
    for (const val of values) {
      if (!arr.includes(val)) {
        allFound = false
        break
      }
    }
    if (allFound) result.add(id)
  }
  return result
}

export function applyMatchesAny(
  values: (string | number | boolean)[],
  docIds: Set<number>,
  getValue: GetFieldValue,
): Set<number> {
  const valSet = new Set<unknown>(values)
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (!Array.isArray(v)) continue
    for (const item of v as unknown[]) {
      if (valSet.has(item)) {
        result.add(id)
        break
      }
    }
  }
  return result
}

export function applySize(sizeFilter: ComparisonFilter, docIds: Set<number>, getValue: GetFieldValue): Set<number> {
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (!Array.isArray(v)) continue
    if (matchesNumericComparison(v.length, sizeFilter)) result.add(id)
  }
  return result
}

export function applyExists(docIds: Set<number>, getValue: GetFieldValue): Set<number> {
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (v !== undefined && v !== null) result.add(id)
  }
  return result
}

export function applyNotExists(docIds: Set<number>, getValue: GetFieldValue): Set<number> {
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (v === undefined || v === null) result.add(id)
  }
  return result
}

export function applyIsEmpty(docIds: Set<number>, getValue: GetFieldValue): Set<number> {
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (v === undefined || v === null) {
      result.add(id)
      continue
    }
    if (typeof v === 'string' && v === '') {
      result.add(id)
      continue
    }
    if (Array.isArray(v) && v.length === 0) {
      result.add(id)
    }
  }
  return result
}

export function applyIsNotEmpty(docIds: Set<number>, getValue: GetFieldValue): Set<number> {
  const result = new Set<number>()
  for (const id of docIds) {
    const v = getValue(id)
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    result.add(id)
  }
  return result
}

export function applyGeoRadius(
  filter: {
    lat: number
    lon: number
    distance: number
    unit: 'km' | 'mi' | 'm'
    inside?: boolean
    highPrecision?: boolean
  },
  geoIndex: GeoFieldIndex,
): Set<number> {
  const distanceMeters = convertToMeters(filter.distance, filter.unit)
  return geoIndex.radiusQuery(
    filter.lat,
    filter.lon,
    distanceMeters,
    filter.inside ?? true,
    filter.highPrecision ?? false,
  )
}

export function applyGeoPolygon(
  filter: { points: Array<{ lat: number; lon: number }>; inside?: boolean },
  geoIndex: GeoFieldIndex,
): Set<number> {
  return geoIndex.polygonQuery(filter.points, filter.inside ?? true)
}

function matchesNumericComparison(value: number, filter: ComparisonFilter): boolean {
  if (filter.eq !== undefined && value !== filter.eq) return false
  if (filter.ne !== undefined && value === filter.ne) return false
  if (filter.gt !== undefined && !(value > filter.gt)) return false
  if (filter.lt !== undefined && !(value < filter.lt)) return false
  if (filter.gte !== undefined && !(value >= filter.gte)) return false
  if (filter.lte !== undefined && !(value <= filter.lte)) return false
  if (filter.between !== undefined && !(value >= filter.between[0] && value <= filter.between[1])) return false
  return true
}
