import type { AnyDocument } from '../../../types/schema'
import { type PartialWordAnalysis, visitDocumentSurfaceSpellings } from '../partial-words/spellings'
import {
  addRemovedSpelling,
  beginRemovedSpellings,
  finishRemovedSpellings,
  NO_REMOVED_SPELLINGS,
} from './removed-spellings'
import type { FrozenSurfaceSlot, RemovedSpellings, TextAnalysis } from './surface-slot'

export { NO_REMOVED_SPELLINGS } from './removed-spellings'

export interface FrozenRemovalDocuments {
  readonly textFields: readonly string[]
  documentAt(ordinal: number): AnyDocument
}

export interface FrozenRemovalPass {
  readonly settled: boolean
  bind(analysis: TextAnalysis): void
  spellingsOf(ordinal: number): RemovedSpellings | undefined
  prepareRemoval(ordinal: number, spellings: RemovedSpellings | undefined): () => void
}

export function createFrozenRemovalPass(
  documents: FrozenRemovalDocuments,
  surfaces: FrozenSurfaceSlot,
): FrozenRemovalPass {
  let bound: PartialWordAnalysis | null = null
  let pending: number[] = []

  function heldSpellingsOf(ordinal: number, analysis: PartialWordAnalysis): RemovedSpellings {
    const onDisk = surfaces.tableStaysOnDisk()
    if (!onDisk && !surfaces.holdsAny()) return NO_REMOVED_SPELLINGS
    beginRemovedSpellings()
    visitDocumentSurfaceSpellings(documents.documentAt(ordinal), analysis, spelling => {
      if (onDisk || surfaces.tokenOf(spelling) !== undefined) addRemovedSpelling(spelling, 1)
    })
    return finishRemovedSpellings()
  }

  return {
    get settled(): boolean {
      return pending.length === 0
    },

    bind(analysis: TextAnalysis): void {
      if (bound !== null) return
      const scoped: PartialWordAnalysis = { ...analysis, fields: documents.textFields }
      const spellings = pending.map(ordinal => heldSpellingsOf(ordinal, scoped))
      for (let at = 0; at < pending.length; at++) surfaces.subtractSpellings(pending[at], spellings[at])
      bound = scoped
      pending = []
    },

    spellingsOf(ordinal: number): RemovedSpellings | undefined {
      return bound === null ? undefined : heldSpellingsOf(ordinal, bound)
    },

    prepareRemoval(ordinal: number, spellings: RemovedSpellings | undefined): () => void {
      const prepared = spellings ?? (bound === null ? undefined : heldSpellingsOf(ordinal, bound))
      if (prepared === undefined)
        return () => {
          pending.push(ordinal)
        }
      return surfaces.prepareRemoval(ordinal, prepared)
    },
  }
}
