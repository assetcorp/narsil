import { ErrorCodes, NarsilError } from '../../errors'
import type { FilterExpression } from '../../types/filters'
import type { FieldType } from '../../types/schema'
import { FILTER_COPY_DEPTH, MAX_FILTER_DEPTH, MAX_FILTER_TESTS } from '../constants'
import { FIELD_FILTER_OPERATORS, FILTER_EXPRESSION_KEYS } from '../keys'
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
import {
  ELEMENT_OPERATORS,
  PRESENCE_OPERATORS,
  requireElementOperands,
  requirePresenceOperands,
  requireSizeOperands,
  requireWholeValueIndex,
  SIZE_OPERAND_KEYS,
  WHOLE_VALUE_OPERATORS,
} from './lists'
import { PATTERN_OPERAND_KEYS, requirePatternOperands, requireWellFormedText } from './pattern'

const RANGE_OPERATORS = ['gt', 'lt', 'gte', 'lte'] as const
const TEXT_OPERATORS = ['startsWith', 'endsWith'] as const
const EQUALITY_OPERATORS = ['eq', 'ne'] as const
const LIST_OPERATORS = ['in', 'nin'] as const
const GEO_OPERATORS = ['radius', 'polygon'] as const
const TEST_MODIFIERS: ReadonlySet<string> = new Set(['caseFold', 'tolerance'])
const EXPRESSION_KEYS: ReadonlySet<string> = new Set(FILTER_EXPRESSION_KEYS)
const OPERATOR_KEYS: ReadonlySet<string> = new Set(FIELD_FILTER_OPERATORS)

const validatedFilters = new WeakMap<object, Readonly<Record<string, FieldType>>>()

type OperandCheck = (fieldPath: string, filter: Record<string, unknown>, type: FieldType) => void

function invalidShape(message: string): never {
  throw new NarsilError(ErrorCodes.SEARCH_INVALID_FILTER, message)
}

function invalidKey(message: string, key: string): never {
  throw new NarsilError(ErrorCodes.SEARCH_INVALID_FILTER, message, { key })
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

const OPERAND_CHECKS: ReadonlyArray<readonly [readonly string[], OperandCheck]> = [
  [[...RANGE_OPERATORS, 'between'], requireRangeOperands],
  [[...TEXT_OPERATORS, ...EQUALITY_OPERATORS, ...LIST_OPERATORS, ...GEO_OPERATORS], requireValueOperands],
  [WHOLE_VALUE_OPERATORS, requireWholeValueIndex],
  [PRESENCE_OPERATORS, requirePresenceOperands],
  [ELEMENT_OPERATORS, requireElementOperands],
  [SIZE_OPERAND_KEYS, requireSizeOperands],
  [PATTERN_OPERAND_KEYS, requirePatternOperands],
  [GEO_OPERATORS, requireGeoOperands],
]

const CHECKS_BY_OPERATOR: ReadonlyMap<string, number> = checksByOperator()

function checksByOperator(): Map<string, number> {
  const checks = new Map<string, number>()
  for (let at = 0; at < OPERAND_CHECKS.length; at++) {
    for (const operator of OPERAND_CHECKS[at][0]) checks.set(operator, (checks.get(operator) ?? 0) | (1 << at))
  }
  return checks
}

function testsOfOperator(operator: string, operand: unknown): number {
  if (TEST_MODIFIERS.has(operator)) return 0
  return operator === 'size' && isObjectRecord(operand) ? Math.max(1, Object.keys(operand).length) : 1
}

function requireValidFieldTests(fieldPath: string, filter: Record<string, unknown>, type: FieldType): number {
  let wanted = 0
  let tests = 0
  for (const operator in filter) {
    if (Object.hasOwn(filter, operator)) {
      if (!OPERATOR_KEYS.has(operator)) {
        invalidKey(`Field "${fieldPath}" is tested with "${operator}", which is no filter operator`, operator)
      }
      const operand = filter[operator]
      requireWellFormedText(fieldPath, operator, operand)
      tests += testsOfOperator(operator, operand)
    }
    wanted |= CHECKS_BY_OPERATOR.get(operator) ?? 0
  }
  for (let at = 0; wanted !== 0; at++, wanted >>>= 1) {
    if ((wanted & 1) !== 0) OPERAND_CHECKS[at][1](fieldPath, filter, type)
  }
  return Math.max(1, tests)
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
  for (const [operator, operand] of Object.entries(filter)) tests += testsOfOperator(operator, operand)
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
  for (const key of Object.keys(expression)) {
    if (EXPRESSION_KEYS.has(key)) continue
    invalidKey(
      `A filter expression takes "fields", "and", "or", and "not", and "${key}" is none of them. A per-field test such as { ${key}: { eq: ... } } belongs under "fields"`,
      key,
    )
  }
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
    countTests(walk, requireValidFieldTests(fieldPath, filter, type))
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

function ownedCopyOf(value: unknown, depth: number): unknown {
  if (typeof value !== 'object' || value === null || depth >= FILTER_COPY_DEPTH) return value
  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length)
    for (let at = 0; at < value.length; at++) copy[at] = ownedCopyOf(value[at], depth + 1)
    return copy
  }
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).map(key => [key, ownedCopyOf(record[key], depth + 1)]))
}

export function validatedFilterOf(
  expression: FilterExpression,
  fieldTypes: Readonly<Record<string, FieldType>>,
): FilterExpression {
  if (validatedFilters.get(expression) === fieldTypes) return expression
  const owned = ownedCopyOf(expression, 0)
  requireValidExpression(owned, { fieldTypes, tests: 0 }, 0)
  const validated = owned as FilterExpression
  validatedFilters.set(validated, fieldTypes)
  return validated
}
