import { patternSearchModule } from '../../pattern/module'
import type { PatternSearchModule } from './types'

export function platformPatternSearch(): PatternSearchModule | null {
  return patternSearchModule
}
