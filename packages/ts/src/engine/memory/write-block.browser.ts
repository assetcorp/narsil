export type {
  MemoryGroupedItem,
  MemoryGroupedWrite,
  MemoryGroupRefusal,
  MemoryReservation,
  MemoryWriteBlock,
  MemoryWriteBlockDeps,
} from './write-block'

import { PASS_THROUGH_WRITE_BLOCK } from './pass-through'
import type { MemoryWriteBlock, MemoryWriteBlockDeps } from './write-block'

export function validateMemorySettings(_settings: unknown): void {}

export function createMemoryWriteBlock(_deps: MemoryWriteBlockDeps): MemoryWriteBlock {
  return PASS_THROUGH_WRITE_BLOCK
}
