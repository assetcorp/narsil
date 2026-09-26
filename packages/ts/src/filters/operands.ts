import { ErrorCodes, NarsilError } from '../errors'
import type { FilterExpression } from '../types/filters'
import type { FieldType } from '../types/schema'

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

function requireRadius(fieldPath: string, radius: unknown): void {
  const circle = radius as Record<string, unknown> | null
  if (circle === null || typeof circle !== 'object') {
    invalid(`The engine takes "radius" on field "${fieldPath}" as an object`, fieldPath, 'radius')
  }
  for (const key of ['lat', 'lon', 'distance']) {
    if (!isFiniteNumber(circle[key])) {
      invalid(`The engine takes "radius.${key}" on field "${fieldPath}" as a finite number`, fieldPath, 'radius')
    }
  }
  if ((circle.distance as number) < 0) {
    invalid(
      `The engine takes "radius.distance" on field "${fieldPath}" as zero or more, and this filter sets ${String(circle.distance)}`,
      fieldPath,
      'radius',
    )
  }
}

export function requireValidFilter(
  expression: FilterExpression | undefined,
  fieldTypes: Readonly<Record<string, FieldType>>,
): void {
  if (expression === undefined || expression === null || typeof expression !== 'object') return
  for (const [fieldPath, filter] of Object.entries(expression.fields ?? {})) {
    if (filter !== null && typeof filter === 'object') {
      requireValidOperands(fieldPath, filter as Record<string, unknown>, fieldTypes[fieldPath])
    }
  }
  for (const nested of [...(expression.and ?? []), ...(expression.or ?? [])]) requireValidFilter(nested, fieldTypes)
  requireValidFilter(expression.not, fieldTypes)
}

export function requireValidOperands(
  fieldPath: string,
  filter: Record<string, unknown>,
  type: FieldType | undefined,
): void {
  for (const operator of RANGE_OPERATORS) {
    if (filter[operator] === undefined) continue
    if (!isFiniteNumber(filter[operator])) {
      invalid(`The engine takes "${operator}" on field "${fieldPath}" as a finite number`, fieldPath, operator)
    }
    requireFieldKind(fieldPath, operator, type, ['number'])
  }
  if (filter.between !== undefined) {
    const bounds = filter.between
    if (!Array.isArray(bounds) || bounds.length !== 2 || !isFiniteNumber(bounds[0]) || !isFiniteNumber(bounds[1])) {
      invalid(
        `The engine takes "between" on field "${fieldPath}" as two finite numbers, the lower bound first`,
        fieldPath,
        'between',
      )
    }
    requireFieldKind(fieldPath, 'between', type, ['number'])
  }
  for (const operator of TEXT_OPERATORS) {
    if (filter[operator] === undefined) continue
    if (typeof filter[operator] !== 'string') {
      invalid(`The engine takes "${operator}" on field "${fieldPath}" as a string`, fieldPath, operator)
    }
    requireFieldKind(fieldPath, operator, type, ['text'])
  }
  for (const operator of EQUALITY_OPERATORS) {
    if (filter[operator] === undefined) continue
    const kind = kindOfValue(filter[operator])
    if (kind === undefined) {
      invalid(
        `The engine takes "${operator}" on field "${fieldPath}" as a string, a finite number, or a boolean`,
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
      invalid(`The engine takes "${operator}" on field "${fieldPath}" as a list of strings`, fieldPath, operator)
    }
    requireFieldKind(fieldPath, operator, type, ['text'])
  }
  if (filter.size !== undefined) {
    const size = filter.size
    if (size === null || typeof size !== 'object') {
      invalid(`The engine takes "size" on field "${fieldPath}" as a comparison object`, fieldPath, 'size')
    }
    requireValidOperands(`${fieldPath}.size`, size as Record<string, unknown>, 'number')
  }
  if (filter.radius !== undefined) requireRadius(fieldPath, filter.radius)
}
