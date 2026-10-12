import { parsedTypeOf } from '../../schema/validator/field-type'
import type { FieldType } from '../../types/schema'
import { invalid, isFiniteNumber, isObjectRecord, kindOfValue, type OperandKind, requireListLength } from './checks'

const WHOLE_VALUE_OPERATORS = ['eq', 'ne', 'in', 'nin', 'startsWith', 'endsWith', 'matchesAny', 'containsAll'] as const
const ELEMENT_OPERATORS = ['matchesAny', 'containsAll'] as const
const PRESENCE_OPERATORS = ['exists', 'notExists', 'isEmpty', 'isNotEmpty'] as const
const SIZE_OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'] as const
const SIZE_OPERATOR_SET: ReadonlySet<string> = new Set(SIZE_OPERATORS)

const ELEMENT_KIND_BY_BASE: Readonly<Record<string, OperandKind>> = {
  'number[]': 'number',
  'boolean[]': 'boolean',
  'enum[]': 'text',
  'string[]': 'text',
  'verbatim[]': 'text',
}

export function requireWholeValueIndex(fieldPath: string, filter: Record<string, unknown>, type: FieldType): void {
  const parsed = parsedTypeOf(type)
  if (parsed === undefined || parsed.pattern || (parsed.base !== 'string' && parsed.base !== 'string[]')) return
  for (const operator of WHOLE_VALUE_OPERATORS) {
    if (filter[operator] === undefined) continue
    invalid(
      `"${operator}" compares whole values of field "${fieldPath}", which the engine finds only through a pattern index. A "${parsed.base}" field keeps a pattern index where its type includes "pattern", so declare the field as "${parsed.base}:pattern" in a new index to filter it this way`,
      fieldPath,
      operator,
    )
  }
}

export function requirePresenceOperands(fieldPath: string, filter: Record<string, unknown>): void {
  for (const operator of PRESENCE_OPERATORS) {
    const operand = filter[operator]
    if (operand !== undefined && typeof operand !== 'boolean') {
      invalid(`"${operator}" on field "${fieldPath}" must be true or false`, fieldPath, operator)
    }
  }
}

function listElementKind(fieldPath: string, operator: string, type: FieldType): OperandKind {
  const base = parsedTypeOf(type)?.base
  const kind = base === undefined ? undefined : ELEMENT_KIND_BY_BASE[base]
  if (kind !== undefined) return kind
  return invalid(
    `"${operator}" tests the elements of a list field, while the schema declares field "${fieldPath}" as "${type}"`,
    fieldPath,
    operator,
  )
}

export function requireElementOperands(fieldPath: string, filter: Record<string, unknown>, type: FieldType): void {
  for (const operator of ELEMENT_OPERATORS) {
    const values = filter[operator]
    if (values === undefined) continue
    if (!Array.isArray(values)) invalid(`"${operator}" on field "${fieldPath}" must be a list`, fieldPath, operator)
    requireListLength(fieldPath, operator, values)
    const kind = listElementKind(fieldPath, operator, type)
    if (values.some(value => kindOfValue(value) !== kind)) {
      invalid(
        `Every value of "${operator}" on field "${fieldPath}" must be a ${kind === 'text' ? 'string' : kind === 'number' ? 'finite number' : 'boolean'}, because the field holds a list of them`,
        fieldPath,
        operator,
      )
    }
  }
}

export function requireSizeOperands(fieldPath: string, filter: Record<string, unknown>, type: FieldType): void {
  const size = filter.size
  if (size === undefined) return
  if (!isObjectRecord(size)) invalid(`"size" on field "${fieldPath}" must be a comparison object`, fieldPath, 'size')
  listElementKind(fieldPath, 'size', type)
  for (const [operator, operand] of Object.entries(size)) {
    if (!SIZE_OPERATOR_SET.has(operator)) {
      invalid(
        `"size" on field "${fieldPath}" takes ${SIZE_OPERATORS.join(', ')}, while "${operator}" is none of them`,
        fieldPath,
        'size',
      )
    }
    const bounds = operator === 'between' ? operand : [operand]
    if (!Array.isArray(bounds) || bounds.length !== (operator === 'between' ? 2 : 1) || !bounds.every(isFiniteNumber)) {
      invalid(
        `"size.${operator}" on field "${fieldPath}" must be ${operator === 'between' ? 'two finite numbers, the lower bound first' : 'a finite number'}`,
        fieldPath,
        'size',
      )
    }
  }
}
