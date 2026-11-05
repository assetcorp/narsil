import type { VectorQuantizationMode } from '../../types/schema'
import { OSQ4_MIN_DIMENSION } from './constants'

export function defaultQuantizationFor(dimension: number): VectorQuantizationMode {
  if (dimension >= OSQ4_MIN_DIMENSION) return 'osq4'
  return 'osq8'
}
