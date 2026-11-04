import type { MemoryWriteBlock, MemoryWriteBlockDeps } from './write-block-types'

export function validateMemorySettings(_settings: unknown): void {}

export function createMemoryWriteBlock(_deps: MemoryWriteBlockDeps): MemoryWriteBlock | undefined {
  return undefined
}
