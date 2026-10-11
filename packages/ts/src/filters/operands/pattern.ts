import { exceedsCodePoints, foldedCodePointCount, holdsUnpairedSurrogate } from '../../core/ordering'
import {
  MAX_PATTERN_POSITIONS,
  MAX_PATTERN_TEXT_CODE_POINTS,
  PATTERN_TEST_OPERATORS,
} from '../../core/pattern-index/constants'
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

function requirePatternText(fieldPath: string, operator: string, text: string, caseFold: boolean): void {
  if (exceedsCodePoints(text, MAX_PATTERN_TEXT_CODE_POINTS)) {
    invalid(
      `The text of "${operator}" on pattern field "${fieldPath}" holds more than ${MAX_PATTERN_TEXT_CODE_POINTS} code points`,
      fieldPath,
      operator,
    )
  }
  if (caseFold && foldedCodePointCount(text) > MAX_PATTERN_POSITIONS) {
    invalid(
      `The text of "${operator}" on pattern field "${fieldPath}" has a case fold of more than ${MAX_PATTERN_POSITIONS} code points, while a pattern holds at most ${MAX_PATTERN_POSITIONS} positions`,
      fieldPath,
      operator,
    )
  }
}

const ELEMENT_OPERATORS = ['matchesAny', 'containsAll'] as const

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
  for (const operator of ELEMENT_OPERATORS) {
    const operand = filter[operator]
    if (!Array.isArray(operand)) continue
    for (const text of operand) {
      if (typeof text === 'string') requirePatternText(fieldPath, operator, text, false)
    }
  }
}

export function requireWellFormedText(fieldPath: string, filter: Record<string, unknown>): void {
  for (const [operator, operand] of Object.entries(filter)) {
    const texts: unknown[] = Array.isArray(operand) ? operand : [operand]
    for (const text of texts) {
      if (typeof text !== 'string' || !holdsUnpairedSurrogate(text)) continue
      invalid(
        `The text of "${operator}" on field "${fieldPath}" holds an unpaired surrogate, the half of a character such as an emoji whose other half is missing, so no stored value can hold it`,
        fieldPath,
        operator,
      )
    }
  }
}
