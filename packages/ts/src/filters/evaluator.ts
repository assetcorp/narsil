import { ErrorCodes, NarsilError } from '../errors'
import type {
  ComparisonFilter,
  FieldFilter,
  FilterExpression,
  GeoPolygonFilter,
  GeoRadiusFilter,
} from '../types/filters'
import { applyAnd, applyNot, applyOr } from './combinators'
import type { FieldIndex, GeoFieldIndex, GetFieldValue } from './operators'
import {
  applyBetween,
  applyContainsAll,
  applyEndsWith,
  applyEq,
  applyExists,
  applyGeoPolygon,
  applyGeoRadius,
  applyGt,
  applyGte,
  applyIn,
  applyIsEmpty,
  applyIsNotEmpty,
  applyLt,
  applyLte,
  applyMatchesAny,
  applyNe,
  applyNin,
  applyNotExists,
  applySize,
  applyStartsWith,
} from './operators'

export interface FilterContext {
  fieldIndexes: Record<string, FieldIndex>
  getFieldValue: (docId: string, fieldPath: string) => unknown
  allDocIds: Set<string>
}

export function evaluateFilters(expression: FilterExpression, context: FilterContext): Set<string> {
  const sets: Set<string>[] = []

  if (expression.fields) {
    for (const [fieldPath, filter] of Object.entries(expression.fields)) {
      sets.push(evaluateFieldFilter(fieldPath, filter, context))
    }
  }

  if (expression.and?.length) {
    const andSets = expression.and.map(expr => evaluateFilters(expr, context))
    sets.push(applyAnd(andSets))
  }

  if (expression.or?.length) {
    const orSets = expression.or.map(expr => evaluateFilters(expr, context))
    sets.push(applyOr(orSets))
  }

  if (expression.not) {
    const excluded = evaluateFilters(expression.not, context)
    sets.push(applyNot(context.allDocIds, excluded))
  }

  if (sets.length === 0) return new Set(context.allDocIds)
  if (sets.length === 1) return sets[0]
  return applyAnd(sets)
}

function evaluateFieldFilter(fieldPath: string, filter: FieldFilter, context: FilterContext): Set<string> {
  const fieldIndex = context.fieldIndexes[fieldPath]
  const getValue: GetFieldValue = docId => context.getFieldValue(docId, fieldPath)
  const f = filter as Record<string, unknown>
  const sets: Set<string>[] = []

  if ('radius' in f && f.radius) {
    const geoIndex = resolveGeoIndex(fieldPath, fieldIndex)
    sets.push(applyGeoRadius((filter as GeoRadiusFilter).radius, geoIndex))
  }

  if ('polygon' in f && f.polygon) {
    const geoIndex = resolveGeoIndex(fieldPath, fieldIndex)
    sets.push(applyGeoPolygon((filter as GeoPolygonFilter).polygon, geoIndex))
  }

  if ('eq' in f && f.eq !== undefined) {
    sets.push(applyEq(f.eq as number | string | boolean, context.allDocIds, getValue, fieldIndex))
  }
  if ('ne' in f && f.ne !== undefined) {
    sets.push(applyNe(f.ne as number | string | boolean, context.allDocIds, getValue, fieldIndex))
  }
  if ('gt' in f && f.gt !== undefined) {
    sets.push(applyGt(f.gt as number, context.allDocIds, getValue, fieldIndex))
  }
  if ('lt' in f && f.lt !== undefined) {
    sets.push(applyLt(f.lt as number, context.allDocIds, getValue, fieldIndex))
  }
  if ('gte' in f && f.gte !== undefined) {
    sets.push(applyGte(f.gte as number, context.allDocIds, getValue, fieldIndex))
  }
  if ('lte' in f && f.lte !== undefined) {
    sets.push(applyLte(f.lte as number, context.allDocIds, getValue, fieldIndex))
  }
  if ('between' in f && f.between !== undefined) {
    sets.push(applyBetween(f.between as [number, number], context.allDocIds, getValue, fieldIndex))
  }

  if ('in' in f && f.in !== undefined) {
    sets.push(applyIn(f.in as string[], context.allDocIds, getValue, fieldIndex))
  }
  if ('nin' in f && f.nin !== undefined) {
    sets.push(applyNin(f.nin as string[], context.allDocIds, getValue, fieldIndex))
  }
  if ('startsWith' in f && f.startsWith !== undefined) {
    sets.push(applyStartsWith(f.startsWith as string, context.allDocIds, getValue))
  }
  if ('endsWith' in f && f.endsWith !== undefined) {
    sets.push(applyEndsWith(f.endsWith as string, context.allDocIds, getValue))
  }

  if ('containsAll' in f && f.containsAll !== undefined) {
    sets.push(applyContainsAll(f.containsAll as (string | number | boolean)[], context.allDocIds, getValue))
  }
  if ('matchesAny' in f && f.matchesAny !== undefined) {
    sets.push(applyMatchesAny(f.matchesAny as (string | number | boolean)[], context.allDocIds, getValue))
  }
  if ('size' in f && f.size !== undefined) {
    sets.push(applySize(f.size as ComparisonFilter, context.allDocIds, getValue))
  }

  if ('exists' in f && f.exists !== undefined) {
    sets.push(f.exists ? applyExists(context.allDocIds, getValue) : applyNotExists(context.allDocIds, getValue))
  }
  if ('notExists' in f && f.notExists !== undefined) {
    sets.push(f.notExists ? applyNotExists(context.allDocIds, getValue) : applyExists(context.allDocIds, getValue))
  }
  if ('isEmpty' in f && f.isEmpty !== undefined) {
    sets.push(f.isEmpty ? applyIsEmpty(context.allDocIds, getValue) : applyIsNotEmpty(context.allDocIds, getValue))
  }
  if ('isNotEmpty' in f && f.isNotEmpty !== undefined) {
    sets.push(f.isNotEmpty ? applyIsNotEmpty(context.allDocIds, getValue) : applyIsEmpty(context.allDocIds, getValue))
  }

  if (sets.length === 0) return new Set(context.allDocIds)
  if (sets.length === 1) return sets[0]
  return applyAnd(sets)
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
