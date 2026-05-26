import type { ComparisonFilter } from '../../types/filters'

export type GetFieldValue = (internalId: number) => unknown

export interface NumericFieldIndex {
  eq(value: number): Set<number>
  gt(value: number): Set<number>
  gte(value: number): Set<number>
  lt(value: number): Set<number>
  lte(value: number): Set<number>
  between(min: number, max: number): Set<number>
  allDocIds(): Set<number>
  eqBitset(value: number, capacity: number): Uint32Array
  gtBitset(value: number, capacity: number): Uint32Array
  gteBitset(value: number, capacity: number): Uint32Array
  ltBitset(value: number, capacity: number): Uint32Array
  lteBitset(value: number, capacity: number): Uint32Array
  betweenBitset(min: number, max: number, capacity: number): Uint32Array
  allDocIdsBitset(capacity: number): Uint32Array
}

export interface BooleanFieldIndex {
  getTrue(): Set<number>
  getFalse(): Set<number>
  allDocIds(): Set<number>
  getTrueBitset(capacity: number): Uint32Array
  getFalseBitset(capacity: number): Uint32Array
  allDocIdsBitset(capacity: number): Uint32Array
}

export interface EnumFieldIndex {
  getDocIds(value: string): Set<number>
  allDocIds(): Set<number>
  getDocIdsBitset(value: string, capacity: number): Uint32Array
  getDocIdsInBitset(values: string[], capacity: number): Uint32Array
  allDocIdsBitset(capacity: number): Uint32Array
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

export function matchesNumericComparison(value: number, filter: ComparisonFilter): boolean {
  if (filter.eq !== undefined && value !== filter.eq) return false
  if (filter.ne !== undefined && value === filter.ne) return false
  if (filter.gt !== undefined && !(value > filter.gt)) return false
  if (filter.lt !== undefined && !(value < filter.lt)) return false
  if (filter.gte !== undefined && !(value >= filter.gte)) return false
  if (filter.lte !== undefined && !(value <= filter.lte)) return false
  if (filter.between !== undefined && !(value >= filter.between[0] && value <= filter.between[1])) return false
  return true
}

export function setDifference(a: Set<number>, b: Set<number>): Set<number> {
  const result = new Set<number>()
  for (const item of a) {
    if (!b.has(item)) result.add(item)
  }
  return result
}
