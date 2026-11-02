import { ErrorCodes, NarsilError } from '../../errors'
import type { OpenStore } from './open-store'
import { entryAt } from './ordinal-reads'
import type { VectorStore } from './types'

export interface RetiredVectorPins {
  pin(): void
  unpin(): void
  note(ordinal: number): void
  holds(ordinal: number): boolean
  keptWith(replaced: ReadonlySet<number>): ReadonlySet<number>
  forget(): void
  requireIntact(): void
}

export function createRetiredVectorPins(): RetiredVectorPins {
  let pins = 0
  let lost = false
  const retired = new Set<number>()
  return {
    pin() {
      pins += 1
    },
    unpin() {
      if (pins === 0) return
      pins -= 1
      if (pins > 0) return
      retired.clear()
      lost = false
    },
    note(ordinal) {
      if (pins > 0) retired.add(ordinal)
    },
    holds(ordinal) {
      return retired.has(ordinal)
    },
    keptWith(replaced) {
      if (retired.size === 0) return replaced
      const kept = new Set(replaced)
      for (const ordinal of retired) kept.add(ordinal)
      return kept
    },
    forget() {
      retired.clear()
      if (pins > 0) lost = true
    },
    requireIntact() {
      if (!lost) return
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_SAVE_FAILED,
        'The vector store was emptied while a checkpoint read the vectors it captured, so the checkpoint stops',
      )
    },
  }
}

export function pinnedReads(
  pins: RetiredVectorPins,
  openStore: () => OpenStore | null,
  readable: (ordinal: number) => boolean,
): Pick<VectorStore, 'pinRetiredVectors' | 'unpinRetiredVectors' | 'entryForPinnedOrdinal'> {
  return {
    pinRetiredVectors: () => pins.pin(),
    unpinRetiredVectors: () => pins.unpin(),
    entryForPinnedOrdinal(ordinal) {
      pins.requireIntact()
      const open = openStore()
      if (open === null || !(readable(ordinal) || pins.holds(ordinal))) return undefined
      return entryAt(open, ordinal)
    },
  }
}
