import { MAX_PATTERN_TOLERANCE } from './constants'
import type { PatternTolerance } from './types'

export function isPatternTolerance(value: unknown): value is PatternTolerance {
  if (value === 'auto') return true
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_PATTERN_TOLERANCE
}
