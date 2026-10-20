import { MATCHER_STATE_OVERHEAD_BYTES, MAX_PATTERN_POSITIONS } from '../../core/pattern-index/constants'
import type { ExpressionOperator, PatternHost } from '../../core/pattern-index/types'
import { ErrorCodes, NarsilError } from '../../errors'
import type { PatternProgram } from '../automaton'
import { simulationBytes } from '../position-simulation'
import type { ExpressionLabel, PatternNode } from './ast'
import { compileProgram, planSize } from './compile'
import { lowerPattern, type Plan } from './lower'
import { parseRegex } from './parse-regex'
import { parseWildcard } from './parse-wildcard'
import { patternPositions } from './positions'
import { type Fail, toCodePoints } from './reader'
import { type RunQuery, requiredRuns, spreadRuns } from './required-runs'

export type { RunQuery } from './required-runs'
export { spreadRuns }

export interface PreparedExpression {
  readonly plan: Plan
  readonly runs: RunQuery
}

export interface CompiledExpression {
  readonly program: PatternProgram
  readonly runs: RunQuery
}

function describe(label: ExpressionLabel): string {
  return label.fieldPath === null
    ? `The "${label.operator}" pattern`
    : `The "${label.operator}" pattern on pattern field "${label.fieldPath}"`
}

function failureFor(label: ExpressionLabel): Fail {
  return (reason, at) => {
    throw new NarsilError(ErrorCodes.SEARCH_INVALID_FILTER, `${describe(label)} ${reason}, at code point ${at + 1}`, {
      fieldPath: label.fieldPath,
      operator: label.operator,
      codePoint: at + 1,
    })
  }
}

function parsedWithinLimits(label: ExpressionLabel, text: string, caseFold: boolean, host: PatternHost): PatternNode {
  const codePoints = toCodePoints(text)
  const fail = failureFor(label)
  const node = label.operator === 'regex' ? parseRegex(codePoints, fail) : parseWildcard(codePoints, fail)
  const positions = patternPositions(node, caseFold, host)
  if (positions > MAX_PATTERN_POSITIONS) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_FILTER,
      `${describe(label)} has more than ${MAX_PATTERN_POSITIONS} positions${caseFold ? ' once case folded' : ''}, so the engine refuses it before it builds a matcher. Each code point, class, and set counts once, a count such as {5} multiplies what it repeats, and a number range counts as the pattern it stands for`,
      { fieldPath: label.fieldPath, operator: label.operator, limit: MAX_PATTERN_POSITIONS },
    )
  }
  return node
}

export function checkExpression(
  operator: ExpressionOperator,
  text: string,
  caseFold: boolean,
  fieldPath: string,
  host: PatternHost,
): void {
  parsedWithinLimits({ operator, fieldPath }, text, caseFold, host)
}

export function prepareExpression(
  operator: ExpressionOperator,
  text: string,
  caseFold: boolean,
  host: PatternHost,
): PreparedExpression {
  const node = parsedWithinLimits({ operator, fieldPath: null }, text, caseFold, host)
  return { plan: lowerPattern(node, caseFold, host), runs: requiredRuns(node, host) }
}

export function buildProgram(prepared: PreparedExpression): PatternProgram {
  return compileProgram(prepared.plan)
}

export function compileExpression(
  operator: ExpressionOperator,
  text: string,
  caseFold: boolean,
  host: PatternHost,
): CompiledExpression {
  const prepared = prepareExpression(operator, text, caseFold, host)
  return { program: buildProgram(prepared), runs: prepared.runs }
}

function footprintOf(bytes: number, states: number, positions: number): number {
  return (
    bytes +
    simulationBytes({ states, positions }) +
    MATCHER_STATE_OVERHEAD_BYTES +
    positions * Uint32Array.BYTES_PER_ELEMENT
  )
}

export function programFootprint(program: PatternProgram): number {
  return footprintOf(program.bytes, program.states, program.positions)
}

export function expressionFootprint(
  operator: ExpressionOperator,
  text: string,
  caseFold: boolean,
  host: PatternHost,
): number {
  const { bytes, states, positions } = planSize(prepareExpression(operator, text, caseFold, host).plan)
  return footprintOf(bytes, states, positions)
}
