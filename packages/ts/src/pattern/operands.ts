import { exceedsCodePoints } from '../core/ordering/code-points'
import {
  MAX_PATTERN_POSITIONS,
  MAX_PATTERN_TEXT_CODE_POINTS,
  PATTERN_ELEMENT_OPERATORS,
  PATTERN_EXPRESSION_OPERATORS,
  PATTERN_TEST_OPERATORS,
} from '../core/pattern-index/constants'
import { isPatternTolerance } from '../core/pattern-index/tolerance'
import type { PatternHost } from '../core/pattern-index/types'
import { ErrorCodes, NarsilError } from '../errors'
import { invalid } from '../filters/operands/checks'
import { checkExpression } from './expression'
import { foldedCodePointCount } from './text'
import { distinctTypoRunCount, foldTypoText, typoRunsNeeded } from './typo-text'

function requireTextLength(fieldPath: string, operator: string, text: string): void {
  if (!exceedsCodePoints(text, MAX_PATTERN_TEXT_CODE_POINTS)) return
  invalid(
    `The text of "${operator}" on pattern field "${fieldPath}" holds more than ${MAX_PATTERN_TEXT_CODE_POINTS} code points`,
    fieldPath,
    operator,
  )
}

function requirePatternText(
  fieldPath: string,
  operator: string,
  text: string,
  caseFold: boolean,
  host: PatternHost,
): void {
  requireTextLength(fieldPath, operator, text)
  if (caseFold && foldedCodePointCount(text, host) > MAX_PATTERN_POSITIONS) {
    invalid(
      `The text of "${operator}" on pattern field "${fieldPath}" has a case fold of more than ${MAX_PATTERN_POSITIONS} code points, while a pattern holds at most ${MAX_PATTERN_POSITIONS} positions`,
      fieldPath,
      operator,
    )
  }
}

function requireExpressions(fieldPath: string, filter: Record<string, unknown>, host: PatternHost): void {
  for (const operator of PATTERN_EXPRESSION_OPERATORS) {
    const pattern = filter[operator]
    if (typeof pattern !== 'string') continue
    requireTextLength(fieldPath, operator, pattern)
    checkExpression(operator, pattern, filter.caseFold === true, fieldPath, host)
  }
}

function requireTolerance(fieldPath: string, filter: Record<string, unknown>, host: PatternHost): void {
  const { tolerance, eq } = filter
  if (tolerance === undefined) return
  if (!isPatternTolerance(tolerance)) {
    invalid(`"tolerance" on field "${fieldPath}" must be 0, 1, 2, or "auto"`, fieldPath, 'tolerance')
  }
  if (typeof eq !== 'string') {
    invalid(
      `"tolerance" applies only to an "eq" test, while the filter on field "${fieldPath}" sets no "eq" with text`,
      fieldPath,
      'tolerance',
    )
  }
  if (tolerance === 0 || tolerance === 'auto') return
  const text = foldTypoText(eq, host)
  const requiredRuns = typoRunsNeeded(tolerance, text.longestFold)
  const distinctRuns = distinctTypoRunCount(text, requiredRuns)
  if (distinctRuns >= requiredRuns) return
  throw new NarsilError(
    ErrorCodes.SEARCH_INVALID_FILTER,
    `A tolerance of ${tolerance} on "eq" of pattern field "${fieldPath}" needs ${requiredRuns} distinct runs of three code points in the case fold of the text, while the text holds ${distinctRuns}. Lengthen the text, lower the tolerance, or set it to "auto"`,
    { fieldPath, operator: 'tolerance', requiredRuns, distinctRuns },
  )
}

export function checkPatternOperands(fieldPath: string, filter: Record<string, unknown>, host: PatternHost): void {
  requireExpressions(fieldPath, filter, host)
  const caseFold = filter.caseFold === true
  for (const operator of PATTERN_TEST_OPERATORS) {
    const operand = filter[operator]
    if (typeof operand === 'string') requirePatternText(fieldPath, operator, operand, caseFold, host)
    if (!Array.isArray(operand)) continue
    for (const text of operand) {
      if (typeof text === 'string') requirePatternText(fieldPath, operator, text, caseFold, host)
    }
  }
  for (const operator of PATTERN_ELEMENT_OPERATORS) {
    const operand = filter[operator]
    if (!Array.isArray(operand)) continue
    for (const text of operand) {
      if (typeof text === 'string') requirePatternText(fieldPath, operator, text, false, host)
    }
  }
  requireTolerance(fieldPath, filter, host)
}
