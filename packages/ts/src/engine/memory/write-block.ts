import { ErrorCodes, NarsilError } from '../../errors'
import type { MemoryConfig } from '../../types/config'
import { createMeasuredWriteBlock } from './measured-block'
import { validateMemoryFractions } from './validate'
import type { MemoryWriteBlock, MemoryWriteBlockDeps } from './write-block-types'

const MEMORY_CONFIG_KEYS: Record<keyof MemoryConfig, true> = {
  blockWritesAbove: true,
  resumeWritesBelow: true,
}

export function validateMemorySettings(settings: unknown): void {
  if (settings !== null && typeof settings === 'object') {
    for (const key of Object.keys(settings)) {
      if (Object.hasOwn(MEMORY_CONFIG_KEYS, key)) continue
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        `The configuration sets "memory.${key}", which is no setting that createNarsil accepts. The settings at that level are ${Object.keys(MEMORY_CONFIG_KEYS).join(', ')}`,
        { setting: `memory.${key}`, settings: Object.keys(MEMORY_CONFIG_KEYS) },
      )
    }
  }
  validateMemoryFractions('memory', settings)
}

export function createMemoryWriteBlock(deps: MemoryWriteBlockDeps): MemoryWriteBlock | undefined {
  if (deps.capacityScope !== 'index') return undefined
  const measured = createMeasuredWriteBlock(deps.settings)
  return { refuseWhileFull: measured.refuseWhileFull, memoryReleased: measured.memoryReleased }
}
