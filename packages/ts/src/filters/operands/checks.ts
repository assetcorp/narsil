import { ErrorCodes, NarsilError } from '../../errors'
import { parsedTypeOf } from '../../schema/validator/field-type'
import type { FieldType } from '../../types/schema'
import { MAX_FILTER_ARRAY_SIZE } from '../constants'

export type OperandKind = 'number' | 'boolean' | 'text' | 'geopoint' | 'vector'

export function operandKindOf(type: FieldType | undefined): OperandKind | undefined {
  if (type === undefined) return undefined
  if (type === 'number' || type === 'number[]') return 'number'
  if (type === 'boolean' || type === 'boolean[]') return 'boolean'
  if (type === 'geopoint') return 'geopoint'
  if (type.startsWith('vector[')) return 'vector'
  return 'text'
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function kindOfValue(value: unknown): OperandKind | undefined {
  if (isFiniteNumber(value)) return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return 'text'
  return undefined
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function invalid(message: string, fieldPath: string, operator: string): never {
  throw new NarsilError(ErrorCodes.SEARCH_INVALID_FILTER, message, { fieldPath, operator })
}

export function requireFieldKind(
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

export function requireTextRangeField(fieldPath: string, operator: string, type: FieldType | undefined): void {
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

export function requireListLength(fieldPath: string, operator: string, values: readonly unknown[]): void {
  if (values.length <= MAX_FILTER_ARRAY_SIZE) return
  invalid(
    `"${operator}" on field "${fieldPath}" holds ${values.length} values, while a filter list holds at most ${MAX_FILTER_ARRAY_SIZE}`,
    fieldPath,
    operator,
  )
}
