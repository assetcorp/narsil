import type { TextRangeBounds } from '../core/partition/sort-columns/range'
import { ErrorCodes, NarsilError } from '../errors'
import type {
  ComparisonFilter,
  FieldFilter,
  FilterExpression,
  GeoPolygonFilter,
  GeoRadiusFilter,
} from '../types/filters'
import type { FieldType } from '../types/schema'
import { applyAndBitset, applyNotBitset, applyOrBitset } from './combinators'
import { FIELD_FILTER_OPERATORS, FILTER_EXPRESSION_KEYS } from './keys'
import { requireValidOperands } from './operands'
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
  fieldTypes: Readonly<Record<string, FieldType>>
  fieldIndexes: Record<string, FieldIndex>
  getFieldValue: (internalId: number, fieldPath: string) => unknown
  textRangeBitset: (fieldPath: string, bounds: TextRangeBounds) => Uint32Array
  allDocIds: Set<number>
  capacity: number
  allDocIdsBitset: Uint32Array
}

const UNBOUNDED: Pick<TextRangeBounds, 'lower' | 'upper'> = { lower: null, upper: null }

function textBoundsOf(operator: 'gt' | 'gte' | 'lt' | 'lte', bound: string): TextRangeBounds {
  if (operator === 'gt' || operator === 'gte') {
    return { ...UNBOUNDED, lower: bound, lowerInclusive: operator === 'gte', upperInclusive: false }
  }
  return { ...UNBOUNDED, upper: bound, upperInclusive: operator === 'lte', lowerInclusive: false }
}

const TEXT_RANGE_OPERATORS = ['gt', 'gte', 'lt', 'lte'] as const

const EXPRESSION_KEYS: ReadonlySet<string> = new Set(FILTER_EXPRESSION_KEYS)

const OPERATOR_KEYS: ReadonlySet<string> = new Set(FIELD_FILTER_OPERATORS)

function requireKnownKeys(value: object, known: ReadonlySet<string>, describe: (key: string) => string): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new NarsilError(ErrorCodes.SEARCH_INVALID_FILTER, describe(key), { key })
    }
  }
}

export function evaluateFilters(expression: FilterExpression, context: FilterContext): Uint32Array {
  requireKnownKeys(
    expression,
    EXPRESSION_KEYS,
    key =>
      `A filter expression takes "fields", "and", "or", and "not", and "${key}" is none of them. A per-field test such as { ${key}: { eq: ... } } belongs under "fields"`,
  )

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
  requireKnownKeys(
    filter,
    OPERATOR_KEYS,
    key => `Field "${fieldPath}" is tested with "${key}", which is no filter operator`,
  )

  const f = filter as Record<string, unknown>
  requireValidOperands(fieldPath, f, context.fieldTypes[fieldPath])
  const fieldIndex = context.fieldIndexes[fieldPath]
  const getValue: GetFieldValue = internalId => context.getFieldValue(internalId, fieldPath)
  const bitsets: Uint32Array[] = []
  const { capacity } = context
  let allDocsBitset: Uint32Array | null = null
  const getAllDocsBitset = (): Uint32Array => {
    if (allDocsBitset === null) {
      allDocsBitset = context.allDocIdsBitset
    }
    return allDocsBitset
  }

  if ('radius' in f && f.radius) {
    const geoIndex = resolveGeoIndex(fieldPath, fieldIndex)
    bitsets.push(applyGeoRadiusBitset((filter as GeoRadiusFilter).radius, geoIndex, capacity))
  }

  if ('polygon' in f && f.polygon) {
    const geoIndex = resolveGeoIndex(fieldPath, fieldIndex)
    bitsets.push(applyGeoPolygonBitset((filter as GeoPolygonFilter).polygon, geoIndex, capacity))
  }

  if ('eq' in f && f.eq !== undefined) {
    bitsets.push(applyEqBitset(f.eq as number | string | boolean, getAllDocsBitset, capacity, getValue, fieldIndex))
  }
  if ('ne' in f && f.ne !== undefined) {
    bitsets.push(applyNeBitset(f.ne as number | string | boolean, getAllDocsBitset, capacity, getValue, fieldIndex))
  }
  for (const operator of TEXT_RANGE_OPERATORS) {
    const bound = f[operator]
    if (typeof bound === 'string') bitsets.push(context.textRangeBitset(fieldPath, textBoundsOf(operator, bound)))
  }
  if (typeof f.gt === 'number') {
    bitsets.push(applyGtBitset(f.gt, getAllDocsBitset, capacity, getValue, fieldIndex))
  }
  if (typeof f.lt === 'number') {
    bitsets.push(applyLtBitset(f.lt, getAllDocsBitset, capacity, getValue, fieldIndex))
  }
  if (typeof f.gte === 'number') {
    bitsets.push(applyGteBitset(f.gte, getAllDocsBitset, capacity, getValue, fieldIndex))
  }
  if (typeof f.lte === 'number') {
    bitsets.push(applyLteBitset(f.lte, getAllDocsBitset, capacity, getValue, fieldIndex))
  }
  if (Array.isArray(f.between)) {
    const [low, high] = f.between as [unknown, unknown]
    if (typeof low === 'string' && typeof high === 'string') {
      bitsets.push(
        context.textRangeBitset(fieldPath, { lower: low, lowerInclusive: true, upper: high, upperInclusive: true }),
      )
    } else {
      bitsets.push(
        applyBetweenBitset([low as number, high as number], getAllDocsBitset, capacity, getValue, fieldIndex),
      )
    }
  }

  if ('in' in f && f.in !== undefined) {
    bitsets.push(applyInBitset(f.in as string[], getAllDocsBitset, capacity, getValue, fieldIndex))
  }
  if ('nin' in f && f.nin !== undefined) {
    bitsets.push(applyNinBitset(f.nin as string[], getAllDocsBitset, capacity, getValue, fieldIndex))
  }
  if ('startsWith' in f && f.startsWith !== undefined) {
    bitsets.push(applyStartsWithBitset(f.startsWith as string, getAllDocsBitset, capacity, getValue))
  }
  if ('endsWith' in f && f.endsWith !== undefined) {
    bitsets.push(applyEndsWithBitset(f.endsWith as string, getAllDocsBitset, capacity, getValue))
  }

  if ('containsAll' in f && f.containsAll !== undefined) {
    bitsets.push(
      applyContainsAllBitset(f.containsAll as (string | number | boolean)[], getAllDocsBitset, capacity, getValue),
    )
  }
  if ('matchesAny' in f && f.matchesAny !== undefined) {
    bitsets.push(
      applyMatchesAnyBitset(f.matchesAny as (string | number | boolean)[], getAllDocsBitset, capacity, getValue),
    )
  }
  if ('size' in f && f.size !== undefined) {
    bitsets.push(applySizeBitset(f.size as ComparisonFilter, getAllDocsBitset, capacity, getValue))
  }

  if ('exists' in f && f.exists !== undefined) {
    bitsets.push(
      f.exists
        ? applyExistsBitset(getAllDocsBitset, capacity, getValue)
        : applyNotExistsBitset(getAllDocsBitset, capacity, getValue),
    )
  }
  if ('notExists' in f && f.notExists !== undefined) {
    bitsets.push(
      f.notExists
        ? applyNotExistsBitset(getAllDocsBitset, capacity, getValue)
        : applyExistsBitset(getAllDocsBitset, capacity, getValue),
    )
  }
  if ('isEmpty' in f && f.isEmpty !== undefined) {
    bitsets.push(
      f.isEmpty
        ? applyIsEmptyBitset(getAllDocsBitset, capacity, getValue)
        : applyIsNotEmptyBitset(getAllDocsBitset, capacity, getValue),
    )
  }
  if ('isNotEmpty' in f && f.isNotEmpty !== undefined) {
    bitsets.push(
      f.isNotEmpty
        ? applyIsNotEmptyBitset(getAllDocsBitset, capacity, getValue)
        : applyIsEmptyBitset(getAllDocsBitset, capacity, getValue),
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
