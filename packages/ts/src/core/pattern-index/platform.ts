import { patternSearchModule } from '../../pattern/module'
import { matchPattern } from '../../pattern/native'
import type { PatternSearchModule } from './types'

const nativePatternSearch: PatternSearchModule = { ...patternSearchModule, matchInto: matchPattern }

export function platformPatternSearch(): PatternSearchModule | null {
  return nativePatternSearch
}
