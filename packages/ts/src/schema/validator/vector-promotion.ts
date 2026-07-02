import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorIndexConfig } from '../../types/schema'

/**
 * A threshold at or below zero makes the promotion trigger fire on every insert
 * once the first graph exists, and a non-numeric value makes the comparison
 * never fire, leaving the field on a linear scan with no signal. Both slip past
 * the `?? default` fallback, so reject anything but a positive integer here.
 */
export function validateVectorPromotion(config: VectorIndexConfig | undefined): void {
  const threshold = config?.threshold
  if (threshold === undefined) return
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'vectorPromotion.threshold must be a positive integer', {
      threshold,
    })
  }
}
