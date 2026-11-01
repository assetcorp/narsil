import type { AnyDocument } from '../../../types/schema'
import { type PartialWordAnalysis, visitDocumentSurfaceSpellings } from '../partial-words/spellings'
import type { FrozenSurfaceSlot, RemovedSpellings, TextAnalysis } from './surface-slot'

export const NO_REMOVED_SPELLINGS: RemovedSpellings = []

export interface FrozenRemovalDocuments {
  readonly textFields: readonly string[]
  documentAt(ordinal: number): AnyDocument
}

export interface FrozenRemovalPass {
  readonly settled: boolean
  bind(analysis: TextAnalysis): void
  spellingsOf(ordinal: number): RemovedSpellings | undefined
  afterRemoval(ordinal: number, spellings: RemovedSpellings | undefined): void
}

export function createFrozenRemovalPass(
  documents: FrozenRemovalDocuments,
  surfaces: FrozenSurfaceSlot,
): FrozenRemovalPass {
  let bound: PartialWordAnalysis | null = null
  let pending: number[] = []

  function heldSpellingsOf(ordinal: number, analysis: PartialWordAnalysis): RemovedSpellings {
    const spellings: string[] = []
    if (!surfaces.holdsAny()) return spellings
    visitDocumentSurfaceSpellings(documents.documentAt(ordinal), analysis, spelling => {
      if (surfaces.holds(spelling)) spellings.push(spelling)
    })
    return spellings
  }

  function subtract(ordinal: number, analysis: PartialWordAnalysis): void {
    if (surfaces.tableStaysOnDisk()) surfaces.subtractOnceLoaded(ordinal, analysis)
    else surfaces.subtractSpellings(ordinal, heldSpellingsOf(ordinal, analysis))
  }

  return {
    get settled(): boolean {
      return pending.length === 0
    },

    bind(analysis: TextAnalysis): void {
      if (bound !== null) return
      const scoped: PartialWordAnalysis = { ...analysis, fields: documents.textFields }
      bound = scoped
      for (const ordinal of pending) subtract(ordinal, scoped)
      pending = []
    },

    spellingsOf(ordinal: number): RemovedSpellings | undefined {
      return bound === null || surfaces.tableStaysOnDisk() ? undefined : heldSpellingsOf(ordinal, bound)
    },

    afterRemoval(ordinal: number, spellings: RemovedSpellings | undefined): void {
      if (spellings !== undefined) {
        surfaces.subtractSpellings(ordinal, spellings)
      } else if (bound !== null) {
        subtract(ordinal, bound)
      } else {
        pending.push(ordinal)
      }
    },
  }
}
