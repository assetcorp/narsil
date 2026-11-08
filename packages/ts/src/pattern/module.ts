import { matchPattern } from '#platform/pattern-test'
import { appendFoldedCodePoint } from '../core/ordering/fold-compare'
import { singleFoldTable } from '../core/ordering/fold-table'
import type { PatternHost, PatternSearchModule } from '../core/pattern-index/types'
import { storedValuesOf } from '../core/stored-values/columns'
import { checkExpression, expressionFootprint } from './expression'
import { evaluatePatternTests } from './filter-tests'
import { largestPatternFootprintIn } from './footprint'
import { readPatternArrays } from './frozen-index'
import { createGrowingPatternIndex } from './growing-index'
import { mergePatternArrays } from './merge'
import { checkPatternOperands } from './operands'
import { decodePatternIndex, serializePatternIndex } from './snapshot'

const host: PatternHost = { appendFoldedCodePoint, singleFolds: singleFoldTable }

export const patternSearchModule: PatternSearchModule = {
  name: 'pattern',
  host: () => host,
  storedValues: storedValuesOf,
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
