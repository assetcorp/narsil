import { ErrorCodes, NarsilError } from '../errors'
import type {
  ComparisonFilter,
  FieldFilter,
  FilterExpression,
  GeoPolygonFilter,
  GeoRadiusFilter,
} from '../types/filters'
import { applyAndBitset, applyNotBitset, applyOrBitset } from './combinators'
import type { FieldIndex, GeoFieldIndex, GetFieldValue } from './operators'
import {
  applyBetweenBitset,
  applyContainsAllBitset,
  applyEndsWithBitset,
  applyEqBitset,
  applyExistsBitset,
  applyGeoPolygonBitset,
  applyGeoRadiusBitset,
  applyGtBitset,
  applyGteBitset,
  applyInBitset,
  applyIsEmptyBitset,
  applyIsNotEmptyBitset,
  applyLtBitset,
  applyLteBitset,
  applyMatchesAnyBitset,
  applyNeBitset,
  applyNinBitset,
  applyNotExistsBitset,
  applySizeBitset,
  applyStartsWithBitset,
} from './operators'

export interface FilterContext {
  fieldIndexes: Record<string, FieldIndex>
  getFieldValue: (internalId: number, fieldPath: string) => unknown
  allDocIds: Set<number>
  capacity: number
  allDocIdsBitset: Uint32Array
}

export function evaluateFilters(expression: FilterExpression, context: FilterContext): Uint32Array {
  const bitsets: Uint32Array[] = []

  if (expression.fields) {
    for (const [fieldPath, filter] of Object.entries(expression.fields)) {
      bitsets.push(evaluateFieldFilter(fieldPath, filter, context))
    }
  }

  if (expression.and?.length) {
    const andBitsets = expression.and.map(expr => evaluateFilters(expr, context))
    bitsets.push(applyAndBitset(andBitsets))
  }

  if (expression.or?.length) {
    const orBitsets = expression.or.map(expr => evaluateFilters(expr, context))
    bitsets.push(applyOrBitset(orBitsets))
  }

  if (expression.not) {
    const excluded = evaluateFilters(expression.not, context)
    const universe = context.allDocIdsBitset
    bitsets.push(applyAndBitset([universe, applyNotBitset(excluded, context.capacity)]))
  }

  if (bitsets.length === 0) return context.allDocIdsBitset
  if (bitsets.length === 1) return bitsets[0]
  return applyAndBitset(bitsets)
}

function evaluateFieldFilter(fieldPath: string, filter: FieldFilter, context: FilterContext): Uint32Array {
  const fieldIndex = context.fieldIndexes[fieldPath]
  const getValue: GetFieldValue = internalId => context.getFieldValue(internalId, fieldPath)
  const f = filter as Record<string, unknown>
  const bitsets: Uint32Array[] = []
  const { capacity, allDocIdsBitset } = context

  if ('radius' in f && f.radius) {
    const geoIndex = resolveGeoIndex(fieldPath, fieldIndex)
    bitsets.push(applyGeoRadiusBitset((filter as GeoRadiusFilter).radius, geoIndex, capacity))
  }

  if ('polygon' in f && f.polygon) {
    const geoIndex = resolveGeoIndex(fieldPath, fieldIndex)
    bitsets.push(applyGeoPolygonBitset((filter as GeoPolygonFilter).polygon, geoIndex, capacity))
  }

  if ('eq' in f && f.eq !== undefined) {
    bitsets.push(applyEqBitset(f.eq as number | string | boolean, allDocIdsBitset, capacity, getValue, fieldIndex))
  }
  if ('ne' in f && f.ne !== undefined) {
    bitsets.push(applyNeBitset(f.ne as number | string | boolean, allDocIdsBitset, capacity, getValue, fieldIndex))
  }
  if ('gt' in f && f.gt !== undefined) {
    bitsets.push(applyGtBitset(f.gt as number, allDocIdsBitset, capacity, getValue, fieldIndex))
  }
  if ('lt' in f && f.lt !== undefined) {
    bitsets.push(applyLtBitset(f.lt as number, allDocIdsBitset, capacity, getValue, fieldIndex))
  }
  if ('gte' in f && f.gte !== undefined) {
    bitsets.push(applyGteBitset(f.gte as number, allDocIdsBitset, capacity, getValue, fieldIndex))
  }
  if ('lte' in f && f.lte !== undefined) {
    bitsets.push(applyLteBitset(f.lte as number, allDocIdsBitset, capacity, getValue, fieldIndex))
  }
  if ('between' in f && f.between !== undefined) {
    bitsets.push(applyBetweenBitset(f.between as [number, number], allDocIdsBitset, capacity, getValue, fieldIndex))
  }

  if ('in' in f && f.in !== undefined) {
    bitsets.push(applyInBitset(f.in as string[], allDocIdsBitset, capacity, getValue, fieldIndex))
  }
  if ('nin' in f && f.nin !== undefined) {
    bitsets.push(applyNinBitset(f.nin as string[], allDocIdsBitset, capacity, getValue, fieldIndex))
  }
  if ('startsWith' in f && f.startsWith !== undefined) {
    bitsets.push(applyStartsWithBitset(f.startsWith as string, allDocIdsBitset, capacity, getValue))
  }
  if ('endsWith' in f && f.endsWith !== undefined) {
    bitsets.push(applyEndsWithBitset(f.endsWith as string, allDocIdsBitset, capacity, getValue))
  }

  if ('containsAll' in f && f.containsAll !== undefined) {
    bitsets.push(
      applyContainsAllBitset(f.containsAll as (string | number | boolean)[], allDocIdsBitset, capacity, getValue),
    )
  }
  if ('matchesAny' in f && f.matchesAny !== undefined) {
    bitsets.push(
      applyMatchesAnyBitset(f.matchesAny as (string | number | boolean)[], allDocIdsBitset, capacity, getValue),
    )
  }
  if ('size' in f && f.size !== undefined) {
    bitsets.push(applySizeBitset(f.size as ComparisonFilter, allDocIdsBitset, capacity, getValue))
  }

  if ('exists' in f && f.exists !== undefined) {
    bitsets.push(
      f.exists
        ? applyExistsBitset(allDocIdsBitset, capacity, getValue)
        : applyNotExistsBitset(allDocIdsBitset, capacity, getValue),
    )
  }
  if ('notExists' in f && f.notExists !== undefined) {
    bitsets.push(
      f.notExists
        ? applyNotExistsBitset(allDocIdsBitset, capacity, getValue)
        : applyExistsBitset(allDocIdsBitset, capacity, getValue),
    )
  }
  if ('isEmpty' in f && f.isEmpty !== undefined) {
    bitsets.push(
      f.isEmpty
        ? applyIsEmptyBitset(allDocIdsBitset, capacity, getValue)
        : applyIsNotEmptyBitset(allDocIdsBitset, capacity, getValue),
    )
  }
  if ('isNotEmpty' in f && f.isNotEmpty !== undefined) {
    bitsets.push(
      f.isNotEmpty
        ? applyIsNotEmptyBitset(allDocIdsBitset, capacity, getValue)
        : applyIsEmptyBitset(allDocIdsBitset, capacity, getValue),
    )
  }

  if (bitsets.length === 0) return context.allDocIdsBitset
  if (bitsets.length === 1) return bitsets[0]
  return applyAndBitset(bitsets)
}

function resolveGeoIndex(fieldPath: string, fieldIndex?: FieldIndex): GeoFieldIndex {
  if (fieldIndex?.type !== 'geopoint') {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_FILTER,
      `Field "${fieldPath}" requires a geopoint index for geo filters`,
      { fieldPath },
    )
  }
  return fieldIndex.index
}
