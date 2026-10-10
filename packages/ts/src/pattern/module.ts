import type { PatternSearchModule } from '../core/pattern-index/types'
import { matchPattern } from './evaluate'
import { readPatternArrays } from './frozen-index'
import { createGrowingPatternIndex } from './growing-index'
import { mergePatternArrays } from './merge'

export const patternSearchModule: PatternSearchModule = {
  name: 'pattern',
  createIndex: createGrowingPatternIndex,
  readArrays: readPatternArrays,
  mergeArrays: mergePatternArrays,
  matchInto: matchPattern,
}
