import { codePointCount } from '../core/ordering/code-points'
import {
  MATCHER_CODE_POINT_BYTES,
  MATCHER_SIMULATION_BYTES_PER_POSITION,
  MATCHER_STATE_OVERHEAD_BYTES,
  PATTERN_EXPRESSION_OPERATORS,
  PATTERN_TEST_OPERATORS,
} from '../core/pattern-index/constants'
import type { PatternHost } from '../core/pattern-index/types'
import type { FilterExpression } from '../types/filters'
import { expressionFootprint } from './expression'
import { foldedCodePointCount } from './text'

const POSITIONS_PER_WORD = 32

function positionWords(positions: number): number {
  return Math.max(1, Math.ceil(positions / POSITIONS_PER_WORD))
}

export function smallestMatcherBytes(positions: number): number {
  return (
    2 * positionWords(positions) * Uint32Array.BYTES_PER_ELEMENT +
    positions * MATCHER_CODE_POINT_BYTES +
    positions * MATCHER_SIMULATION_BYTES_PER_POSITION +
    MATCHER_STATE_OVERHEAD_BYTES +
    positions * Uint32Array.BYTES_PER_ELEMENT
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function literalFootprint(text: unknown, caseFold: boolean, host: PatternHost): number | null {
  if (typeof text !== 'string') return null
  return smallestMatcherBytes(caseFold ? foldedCodePointCount(text, host) : codePointCount(text))
}

function larger(left: number | null, right: number | null): number | null {
  if (left === null) return right
  if (right === null) return left
  return Math.max(left, right)
}

function largestTestOf(filter: Record<string, unknown>, host: PatternHost): number | null {
  const caseFold = filter.caseFold === true
  let largest: number | null = null
  for (const operator of PATTERN_TEST_OPERATORS) {
    const operand = filter[operator]
    if (operand === undefined) continue
    const texts = Array.isArray(operand) ? operand : [operand]
    for (const text of texts) largest = larger(largest, literalFootprint(text, caseFold, host))
  }
  for (const operator of PATTERN_EXPRESSION_OPERATORS) {
    const pattern = filter[operator]
    if (typeof pattern !== 'string') continue
    largest = larger(largest, expressionFootprint(operator, pattern, caseFold, host))
  }
  return largest
}

export function largestPatternFootprintIn(
  expression: FilterExpression,
  patternFields: ReadonlySet<string>,
  host: PatternHost,
): number | null {
  let largest: number | null = null
  if (isRecord(expression.fields)) {
    for (const [fieldPath, filter] of Object.entries(expression.fields)) {
      if (patternFields.has(fieldPath) && isRecord(filter)) largest = larger(largest, largestTestOf(filter, host))
    }
  }
  const nested = [...(expression.and ?? []), ...(expression.or ?? [])]
  if (expression.not !== undefined) nested.push(expression.not)
  for (const child of nested) largest = larger(largest, largestPatternFootprintIn(child, patternFields, host))
  return largest
}
