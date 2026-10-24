import { ErrorCodes, NarsilError } from '../../errors'
import type { FilterExpression } from '../../types/filters'
import type { FieldType } from '../../types/schema'
import { MAX_FILTER_DEPTH, MAX_FILTER_TESTS } from '../constants'
import {
  invalid,
  isFiniteNumber,
  isObjectRecord,
  kindOfValue,
  requireFieldKind,
  requireListLength,
  requireTextRangeField,
} from './checks'
import { requireGeoOperands } from './geo'
import { requireElementOperands, requirePresenceOperands, requireSizeOperands, requireWholeValueIndex } from './lists'
import { requirePatternOperands, requireWellFormedText } from './pattern'

const RANGE_OPERATORS = ['gt', 'lt', 'gte', 'lte'] as const
const TEXT_OPERATORS = ['startsWith', 'endsWith'] as const
const EQUALITY_OPERATORS = ['eq', 'ne'] as const
const LIST_OPERATORS = ['in', 'nin'] as const
const GEO_OPERATORS = ['radius', 'polygon'] as const
const TEST_MODIFIERS: ReadonlySet<string> = new Set(['caseFold', 'tolerance'])

function invalidShape(message: string): never {
  throw new NarsilError(ErrorCodes.SEARCH_INVALID_FILTER, message)
}

export function undeclaredFieldOnStrictIndex(field: string, option: string): NarsilError {
  return new NarsilError(
    ErrorCodes.SEARCH_INVALID_FIELD,
    `The index is strict and its schema declares no field "${field}", so no stored document has a value in that field for this ${option}`,
    { field, option },
  )
}

export function undeclaredFilterField(field: string): NarsilError {
  return new NarsilError(
    ErrorCodes.SEARCH_INVALID_FIELD,
    `The schema declares no field "${field}", while the engine answers a filter only from the indexes that it keeps for declared fields. Declare the field in the schema of a new index to filter by it`,
    { field, option: 'filter' },
  )
}

function requireRangeOperands(fieldPath: string, filter: Record<string, unknown>, type: FieldType): void {
  for (const operator of RANGE_OPERATORS) {
    const bound = filter[operator]
    if (bound === undefined) continue
    if (typeof bound === 'string') {
      requireTextRangeField(fieldPath, operator, type)
      continue
    }
    if (!isFiniteNumber(bound)) {
      invalid(`"${operator}" on field "${fieldPath}" must be a finite number or a string`, fieldPath, operator)
    }
    requireFieldKind(fieldPath, operator, type, ['number'])
  }
  if (filter.between === undefined) return
  const bounds = filter.between
  const isPair = Array.isArray(bounds) && bounds.length === 2
  if (isPair && typeof bounds[0] === 'string' && typeof bounds[1] === 'string') {
    requireTextRangeField(fieldPath, 'between', type)
    return
  }
  if (!isPair || !isFiniteNumber(bounds[0]) || !isFiniteNumber(bounds[1])) {
    invalid(
      `"between" on field "${fieldPath}" must be two finite numbers or two strings, the lower bound first`,
      fieldPath,
      'between',
    )
  }
  requireFieldKind(fieldPath, 'between', type, ['number'])
}

function requireValueOperands(fieldPath: string, filter: Record<string, unknown>, type: FieldType): void {
  for (const operator of TEXT_OPERATORS) {
    if (filter[operator] === undefined) continue
    if (typeof filter[operator] !== 'string') {
      invalid(`"${operator}" on field "${fieldPath}" must be a string`, fieldPath, operator)
    }
    requireFieldKind(fieldPath, operator, type, ['text'])
  }
  for (const operator of EQUALITY_OPERATORS) {
    if (filter[operator] === undefined) continue
    const kind = kindOfValue(filter[operator])
    if (kind === undefined) {
      invalid(
        `"${operator}" on field "${fieldPath}" must be a string, a finite number, or a boolean`,
        fieldPath,
        operator,
      )
    }
    requireFieldKind(fieldPath, operator, type, [kind])
  }
  for (const operator of LIST_OPERATORS) {
    if (filter[operator] === undefined) continue
    const values = filter[operator]
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
      invalid(`"${operator}" on field "${fieldPath}" must be a list of strings`, fieldPath, operator)
    }
    requireListLength(fieldPath, operator, values)
    requireFieldKind(fieldPath, operator, type, ['text'])
  }
  for (const operator of GEO_OPERATORS) {
    if (filter[operator] !== undefined) requireFieldKind(fieldPath, operator, type, ['geopoint'])
  }
}

export function requireValidOperands(fieldPath: string, filter: Record<string, unknown>, type: FieldType): void {
  requireWellFormedText(fieldPath, filter)
  requireRangeOperands(fieldPath, filter, type)
  requireValueOperands(fieldPath, filter, type)
  requireWholeValueIndex(fieldPath, filter, type)
  requirePresenceOperands(fieldPath, filter)
  requireElementOperands(fieldPath, filter, type)
  requireSizeOperands(fieldPath, filter, type)
  requirePatternOperands(fieldPath, filter, type)
  requireGeoOperands(fieldPath, filter)
}

export function filterTestCount(expression: unknown): number {
  if (!isObjectRecord(expression)) return 0
  const fieldFilters = isObjectRecord(expression.fields) ? Object.values(expression.fields) : []
  let tests = fieldFilters.length === 0 && !holdsNestedExpressions(expression) ? 1 : 0
  for (const filter of fieldFilters) tests += isObjectRecord(filter) ? testsIn(filter) : 1
  for (const list of [expression.and, expression.or]) {
    if (Array.isArray(list)) for (const nested of list) tests += filterTestCount(nested)
  }
  return tests + filterTestCount(expression.not)
}

function testsIn(filter: Record<string, unknown>): number {
  let tests = 0
  for (const [operator, operand] of Object.entries(filter)) {
    if (TEST_MODIFIERS.has(operator)) continue
    tests += operator === 'size' && isObjectRecord(operand) ? Math.max(1, Object.keys(operand).length) : 1
  }
  return Math.max(1, tests)
}

function countTests(walk: FilterWalk, tests: number): void {
  walk.tests += tests
  if (walk.tests > MAX_FILTER_TESTS) {
    invalidShape(`A filter holds at most ${MAX_FILTER_TESTS} tests across all of its fields and nested expressions`)
  }
}

function holdsNestedExpressions(expression: Record<string, unknown>): boolean {
  const { and, or, not } = expression
  return (Array.isArray(and) && and.length > 0) || (Array.isArray(or) && or.length > 0) || not !== undefined
}

interface FilterWalk {
  readonly fieldTypes: Readonly<Record<string, FieldType>>
  tests: number
}

function requireValidExpression(expression: unknown, walk: FilterWalk, depth: number): void {
  if (depth > MAX_FILTER_DEPTH) invalidShape(`A filter expression nests at most ${MAX_FILTER_DEPTH} levels deep`)
  if (!isObjectRecord(expression)) invalidShape('Each filter expression must be an object')
  const { fields, and, or, not } = expression
  if (fields !== undefined && !isObjectRecord(fields)) {
    invalidShape('"fields" in a filter expression must be an object keyed by field path')
  }
  const fieldFilters = Object.entries(fields ?? {})
  if (fieldFilters.length === 0 && !holdsNestedExpressions(expression)) countTests(walk, 1)
  for (const [fieldPath, filter] of fieldFilters) {
    const type = walk.fieldTypes[fieldPath]
    if (!Object.hasOwn(walk.fieldTypes, fieldPath) || type === undefined) throw undeclaredFilterField(fieldPath)
    if (!isObjectRecord(filter)) invalidShape(`The filter on field "${fieldPath}" must be an object of tests`)
    countTests(walk, testsIn(filter))
    requireValidOperands(fieldPath, filter, type)
  }
  for (const [clause, list] of [
    ['and', and],
    ['or', or],
  ] as const) {
    if (list === undefined) continue
    if (!Array.isArray(list)) invalidShape(`"${clause}" in a filter expression must be a list of filter expressions`)
    for (const nested of list) requireValidExpression(nested, walk, depth + 1)
  }
  if (not !== undefined) requireValidExpression(not, walk, depth + 1)
}

export function requireValidFilter(
  expression: FilterExpression | undefined,
  fieldTypes: Readonly<Record<string, FieldType>>,
): void {
  if (expression === undefined || expression === null) return
  requireValidExpression(expression, { fieldTypes, tests: 0 }, 0)
}
