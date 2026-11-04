import { ErrorCodes, NarsilError } from '../../errors'
import { DEFAULT_BLOCK_WRITES_ABOVE, DEFAULT_RESUME_WRITES_BELOW } from './constants'

function requireFraction(setting: string, value: unknown): void {
  if (value === undefined) return
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1) return
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, `${setting} must be a number above 0 and at most 1`, {
    [setting.slice(setting.lastIndexOf('.') + 1)]: value,
  })
}

export function validateMemoryFractions(
  section: string,
  memory: unknown,
  extraFractions: readonly string[] = [],
): void {
  if (memory === undefined) return
  if (typeof memory !== 'object' || memory === null || Array.isArray(memory)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `${section} must be an object`, { memory })
  }
  const settings = memory as Record<string, unknown>
  for (const name of ['blockWritesAbove', 'resumeWritesBelow', ...extraFractions]) {
    requireFraction(`${section}.${name}`, settings[name])
  }
  const block = typeof settings.blockWritesAbove === 'number' ? settings.blockWritesAbove : DEFAULT_BLOCK_WRITES_ABOVE
  const resume =
    typeof settings.resumeWritesBelow === 'number' ? settings.resumeWritesBelow : DEFAULT_RESUME_WRITES_BELOW
  if (resume >= block) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `${section}.resumeWritesBelow (${resume}) must lie below blockWritesAbove (${block})`,
      { blockWritesAbove: block, resumeWritesBelow: resume },
    )
  }
}
