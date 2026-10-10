import { exceedsCodePoints, foldedCodePointCount } from '../core/ordering'
import {
  MAX_PATTERN_POSITIONS,
  MAX_PATTERN_TEXT_CODE_POINTS,
  PATTERN_TEST_OPERATORS,
} from '../core/pattern-index/constants'
import { ErrorCodes, NarsilError } from '../errors'
import { requirePolygonRing } from '../geo/polygon'
import { parsedTypeOf } from '../schema/validator/field-type'
import type { FilterExpression } from '../types/filters'
import type { FieldType } from '../types/schema'
import { MAX_FILTER_DEPTH } from './constants'

type OperandKind = 'number' | 'boolean' | 'text' | 'geopoint' | 'vector'

const RANGE_OPERATORS = ['gt', 'lt', 'gte', 'lte'] as const
const TEXT_OPERATORS = ['startsWith', 'endsWith'] as const
const EQUALITY_OPERATORS = ['eq', 'ne'] as const
const LIST_OPERATORS = ['in', 'nin'] as const

function operandKindOf(type: FieldType | undefined): OperandKind | undefined {
  if (type === undefined) return undefined
  if (type === 'number' || type === 'number[]') return 'number'
  if (type === 'boolean' || type === 'boolean[]') return 'boolean'
  if (type === 'geopoint') return 'geopoint'
  if (type.startsWith('vector[')) return 'vector'
  return 'text'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function kindOfValue(value: unknown): OperandKind | undefined {
  if (isFiniteNumber(value)) return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return 'text'
  return undefined
}

function invalid(message: string, fieldPath: string, operator: string): never {
  throw new NarsilError(ErrorCodes.SEARCH_INVALID_FILTER, message, { fieldPath, operator })
}

function requireFieldKind(
  fieldPath: string,
  operator: string,
  type: FieldType | undefined,
  accepted: readonly OperandKind[],
): void {
  const kind = operandKindOf(type)
  if (kind === undefined || accepted.includes(kind)) return
  invalid(
    `The engine applies "${operator}" to ${accepted.join(' or ')} fields alone, and the schema declares field "${fieldPath}" as "${type}"`,
    fieldPath,
    operator,
  )
}

function requireTextRangeField(fieldPath: string, operator: string, type: FieldType | undefined): void {
  const parsed = parsedTypeOf(type)
  if (parsed?.sortable && (parsed.base === 'string' || parsed.base === 'verbatim')) return
  const declared =
    type === undefined ? `the schema has no field "${fieldPath}"` : `field "${fieldPath}" has type "${type}"`
  invalid(
    `The engine applies "${operator}" with a text bound to a "string" or "verbatim" field whose type includes "sortable", but ${declared}`,
    fieldPath,
    operator,
  )
}

function requirePatternField(fieldPath: string, operator: string, type: FieldType | undefined): void {
  if (parsedTypeOf(type)?.pattern === true) return
  const declared =
    type === undefined ? `The schema declares no field "${fieldPath}"` : `Field "${fieldPath}" has type "${type}"`
  invalid(
    `"${operator}" applies to a pattern field alone, meaning a "verbatim" field or a text field whose type includes "pattern", because the engine keeps no pattern index for any other field. ${declared}`,
    fieldPath,
    operator,
  )
}

function requirePatternText(fieldPath: string, operator: string, text: string, caseFold: boolean): void {
  if (exceedsCodePoints(text, MAX_PATTERN_TEXT_CODE_POINTS)) {
    invalid(
      `"${operator}" on pattern field "${fieldPath}" holds more than ${MAX_PATTERN_TEXT_CODE_POINTS} code points`,
      fieldPath,
      operator,
    )
  }
  if (caseFold && foldedCodePointCount(text) > MAX_PATTERN_POSITIONS) {
    invalid(
      `"${operator}" on pattern field "${fieldPath}" folds to more than ${MAX_PATTERN_POSITIONS} code points, which is the most positions that a pattern may hold`,
      fieldPath,
      operator,
    )
  }
}

function requirePatternOperands(fieldPath: string, filter: Record<string, unknown>, type: FieldType | undefined): void {
  if (filter.contains !== undefined) {
    if (typeof filter.contains !== 'string') {
      invalid(`"contains" on field "${fieldPath}" must be a string`, fieldPath, 'contains')
    }
    requirePatternField(fieldPath, 'contains', type)
  }
  if (filter.caseFold !== undefined) {
    if (typeof filter.caseFold !== 'boolean') {
      invalid(`"caseFold" on field "${fieldPath}" must be true or false`, fieldPath, 'caseFold')
    }
    requirePatternField(fieldPath, 'caseFold', type)
  }
  if (parsedTypeOf(type)?.pattern !== true) return
  const caseFold = filter.caseFold === true
  for (const operator of PATTERN_TEST_OPERATORS) {
    const operand = filter[operator]
    if (typeof operand === 'string') requirePatternText(fieldPath, operator, operand, caseFold)
    if (!Array.isArray(operand)) continue
    for (const text of operand) {
      if (typeof text === 'string') requirePatternText(fieldPath, operator, text, caseFold)
    }
  }
}

function requireRadius(fieldPath: string, radius: unknown): void {
  const circle = radius as Record<string, unknown> | null
  if (circle === null || typeof circle !== 'object') {
    invalid(`"radius" on field "${fieldPath}" must be an object`, fieldPath, 'radius')
  }
  for (const key of ['lat', 'lon', 'distance']) {
    if (!isFiniteNumber(circle[key])) {
      invalid(`"radius.${key}" on field "${fieldPath}" must be a finite number`, fieldPath, 'radius')
    }
  }
  if ((circle.distance as number) < 0) {
    invalid(
      `"radius.distance" on field "${fieldPath}" must be zero or more, and this filter sets ${String(circle.distance)}`,
      fieldPath,
      'radius',
    )
  }
}

interface FilterFieldRules {
  fieldTypes: Readonly<Record<string, FieldType>>
  declaredOnly: boolean
}

function invalidShape(message: string): never {
  throw new NarsilError(ErrorCodes.SEARCH_INVALID_FILTER, message)
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function undeclaredFieldOnStrictIndex(field: string, option: string): NarsilError {
  return new NarsilError(
    ErrorCodes.SEARCH_INVALID_FIELD,
    `The index is strict and its schema declares no field "${field}", so no stored document has a value in that field for this ${option}`,
    { field, option },
  )
}

function requireValidExpression(expression: unknown, rules: FilterFieldRules, depth: number): void {
  if (depth > MAX_FILTER_DEPTH) invalidShape(`A filter expression nests at most ${MAX_FILTER_DEPTH} levels deep`)
  if (!isObjectRecord(expression)) invalidShape('Each filter expression must be an object')
  const { fields, and, or, not } = expression
  if (fields !== undefined) {
    if (!isObjectRecord(fields)) invalidShape('"fields" in a filter expression must be an object keyed by field path')
    for (const [fieldPath, filter] of Object.entries(fields)) {
      if (rules.declaredOnly && !Object.hasOwn(rules.fieldTypes, fieldPath)) {
        throw undeclaredFieldOnStrictIndex(fieldPath, 'filter')
      }
      if (isObjectRecord(filter)) requireValidOperands(fieldPath, filter, rules.fieldTypes[fieldPath])
    }
  }
  for (const [clause, list] of [
    ['and', and],
    ['or', or],
  ] as const) {
    if (list === undefined) continue
    if (!Array.isArray(list)) invalidShape(`"${clause}" in a filter expression must be a list of filter expressions`)
    for (const nested of list) requireValidExpression(nested, rules, depth + 1)
  }
  if (not !== undefined) requireValidExpression(not, rules, depth + 1)
}

export function requireValidFilter(
  expression: FilterExpression | undefined,
  fieldTypes: Readonly<Record<string, FieldType>>,
  declaredOnly = false,
): void {
  if (expression === undefined || expression === null) return
  requireValidExpression(expression, { fieldTypes, declaredOnly }, 0)
}

export function requireValidOperands(
  fieldPath: string,
  filter: Record<string, unknown>,
  type: FieldType | undefined,
): void {
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
  if (filter.between !== undefined) {
    const bounds = filter.between
    const isPair = Array.isArray(bounds) && bounds.length === 2
    if (isPair && typeof bounds[0] === 'string' && typeof bounds[1] === 'string') {
      requireTextRangeField(fieldPath, 'between', type)
    } else {
      if (!isPair || !isFiniteNumber(bounds[0]) || !isFiniteNumber(bounds[1])) {
        invalid(
          `"between" on field "${fieldPath}" must be two finite numbers or two strings, the lower bound first`,
          fieldPath,
          'between',
        )
      }
      requireFieldKind(fieldPath, 'between', type, ['number'])
    }
  }
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
    requireFieldKind(fieldPath, operator, type, ['text'])
  }
  if (filter.size !== undefined) {
    const size = filter.size
    if (size === null || typeof size !== 'object') {
      invalid(`"size" on field "${fieldPath}" must be a comparison object`, fieldPath, 'size')
    }
    requireValidOperands(`${fieldPath}.size`, size as Record<string, unknown>, 'number')
  }
  requirePatternOperands(fieldPath, filter, type)
  if (filter.radius !== undefined) requireRadius(fieldPath, filter.radius)
  if (filter.polygon !== undefined) {
    if (!isObjectRecord(filter.polygon)) {
      invalid(`"polygon" on field "${fieldPath}" must be an object`, fieldPath, 'polygon')
    }
    requirePolygonRing(filter.polygon.points)
  }
}
