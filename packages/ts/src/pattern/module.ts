import type { PatternSearchModule } from '../core/pattern-index/types'
import { matchPattern } from './evaluate'
import { checkExpression, expressionFootprint } from './expression'
import { evaluatePatternTests } from './filter-tests'
import { largestPatternFootprintIn } from './footprint'
import { readPatternArrays } from './frozen-index'
import { createGrowingPatternIndex } from './growing-index'
import { mergePatternArrays } from './merge'
import { checkPatternOperands } from './operands'
import { decodePatternIndex, serializePatternIndex } from './snapshot'

export const patternSearchModule: PatternSearchModule = {
  name: 'pattern',
  createIndex: createGrowingPatternIndex,
  readArrays: readPatternArrays,
  mergeArrays: mergePatternArrays,
  matchInto: matchPattern,
  checkExpression,
  expressionFootprint,
  largestFootprint: largestPatternFootprintIn,
  checkOperands: checkPatternOperands,
  evaluateTests: evaluatePatternTests,
  serializeIndex: serializePatternIndex,
  decodeIndex: decodePatternIndex,
}
