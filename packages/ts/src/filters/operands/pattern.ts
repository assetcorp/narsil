import { holdsUnpairedSurrogate } from '../../core/ordering'
import {
  PATTERN_ELEMENT_OPERATORS,
  PATTERN_EXPRESSION_OPERATORS,
  PATTERN_TEST_OPERATORS,
} from '../../core/pattern-index/constants'
import { PATTERN_HOST } from '../../core/pattern-index/host'
import { requirePatternSearch } from '../../core/pattern-index/registry'
import { parsedTypeOf } from '../../schema/validator/field-type'
import type { FieldType } from '../../types/schema'
import { invalid } from './checks'

function requirePatternField(fieldPath: string, operator: string, type: FieldType | undefined): void {
  if (parsedTypeOf(type)?.pattern === true) return
  const declared =
    type === undefined ? `The schema declares no field "${fieldPath}"` : `Field "${fieldPath}" has type "${type}"`
  invalid(
    `"${operator}" applies only to a pattern field, because only a pattern field has a pattern index. A pattern field is a "verbatim" field, or a text field whose type includes "pattern". ${declared}`,
    fieldPath,
    operator,
  )
}

export const PATTERN_OPERAND_KEYS = [
  'contains',
  'caseFold',
  'tolerance',
  ...PATTERN_EXPRESSION_OPERATORS,
  ...PATTERN_TEST_OPERATORS,
  ...PATTERN_ELEMENT_OPERATORS,
] as const

export function requirePatternOperands(
  fieldPath: string,
  filter: Record<string, unknown>,
  type: FieldType | undefined,
): void {
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
  for (const operator of PATTERN_EXPRESSION_OPERATORS) {
    const pattern = filter[operator]
    if (pattern === undefined) continue
    if (typeof pattern !== 'string')
      invalid(`"${operator}" on field "${fieldPath}" must be a string`, fieldPath, operator)
    requirePatternField(fieldPath, operator, type)
  }
  if (filter.tolerance !== undefined) requirePatternField(fieldPath, 'tolerance', type)
  if (parsedTypeOf(type)?.pattern !== true) return
  requirePatternSearch(fieldPath).checkOperands(fieldPath, filter, PATTERN_HOST)
}

function requireWellFormedOperand(fieldPath: string, operator: string, text: unknown): void {
  if (typeof text !== 'string' || !holdsUnpairedSurrogate(text)) return
  invalid(
    `The text of "${operator}" on field "${fieldPath}" holds an unpaired surrogate, the half of a character such as an emoji whose other half is missing, so no stored value can hold it`,
    fieldPath,
    operator,
  )
}

export function requireWellFormedText(fieldPath: string, operator: string, operand: unknown): void {
  if (!Array.isArray(operand)) {
    requireWellFormedOperand(fieldPath, operator, operand)
    return
  }
  for (const text of operand) requireWellFormedOperand(fieldPath, operator, text)
}
