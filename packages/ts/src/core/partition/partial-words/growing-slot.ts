import type { AnyDocument } from '../../../types/schema'
import {
  GROWING_PARTIAL_COUNTED_SPELLING_BYTES,
  GROWING_PARTIAL_ENTRY_BYTES,
  GROWING_PARTIAL_RUN_BYTES,
  GROWING_PARTIAL_RUN_MEMBER_BYTES,
  PARTIAL_WORD_RUN_CODE_POINTS,
} from './constants'
import {
  countDocumentSpellings,
  encodePartialSpellings,
  type PartialSpellings,
  type PartialWordAnalysis,
  type SpellingCounts,
  sameFields,
} from './spellings'
import { codePointsOf, runKeyAt } from './text'
import type {
  GrowingPartialWordSlot,
  GrowingPartialWordView,
  PartialWordProbe,
  PartialWordReader,
  PartialWordVisitor,
} from './types'

export function createGrowingPartialWordSlot(view: GrowingPartialWordView): GrowingPartialWordSlot {
  let fields: readonly string[] = []
  let everyDocumentPending = false
  const pending = new Set<number>()
  const counts: SpellingCounts = new Map()
  const entriesByToken = new Map<string, Map<string, number>>()
  const entrySpellings: string[] = []
  const entryTokens: string[] = []
  const entryLengths: number[] = []
  const freeEntries: number[] = []
  const runs = new Map<string, Set<number>>()
  let liveEntries = 0
  let runMembers = 0
  let countedSpellings = 0

  function resetSpellings(): void {
    pending.clear()
    counts.clear()
    countedSpellings = 0
    entriesByToken.clear()
    entrySpellings.length = 0
    entryTokens.length = 0
    entryLengths.length = 0
    freeEntries.length = 0
    runs.clear()
    liveEntries = 0
    runMembers = 0
  }

  function addEntry(token: string, spelling: string): void {
    const points = codePointsOf(spelling)
    if (points.length <= PARTIAL_WORD_RUN_CODE_POINTS) return
    const entry = freeEntries.pop() ?? entrySpellings.length
    entrySpellings[entry] = spelling
    entryTokens[entry] = token
    entryLengths[entry] = points.length
    let byToken = entriesByToken.get(token)
    if (byToken === undefined) {
      byToken = new Map()
      entriesByToken.set(token, byToken)
    }
    byToken.set(spelling, entry)
    liveEntries++
    for (let at = 0; at + PARTIAL_WORD_RUN_CODE_POINTS <= points.length; at++) {
      const key = runKeyAt(points, at)
      let members = runs.get(key)
      if (members === undefined) {
        members = new Set()
        runs.set(key, members)
      }
      if (members.has(entry)) continue
      members.add(entry)
      runMembers++
    }
  }

  function removeEntry(token: string, spelling: string): void {
    const byToken = entriesByToken.get(token)
    const entry = byToken?.get(spelling)
    if (byToken === undefined || entry === undefined) return
    const points = codePointsOf(spelling)
    for (let at = 0; at + PARTIAL_WORD_RUN_CODE_POINTS <= points.length; at++) {
      const key = runKeyAt(points, at)
      const members = runs.get(key)
      if (members === undefined || !members.delete(entry)) continue
      runMembers--
      if (members.size === 0) runs.delete(key)
    }
    byToken.delete(spelling)
    if (byToken.size === 0) entriesByToken.delete(token)
    entrySpellings[entry] = ''
    entryTokens[entry] = ''
    entryLengths[entry] = 0
    freeEntries.push(entry)
    liveEntries--
  }

  function change(token: string, spelling: string, delta: number): void {
    let byToken = counts.get(token)
    const before = byToken?.get(spelling) ?? 0
    const after = Math.max(0, before + delta)
    if (after === before) return
    if (byToken === undefined) {
      byToken = new Map()
      counts.set(token, byToken)
    }
    if (after > 0) byToken.set(spelling, after)
    else byToken.delete(spelling)
    if (byToken.size === 0) counts.delete(token)
    if (before === 0) {
      countedSpellings++
      addEntry(token, spelling)
    } else if (after === 0) {
      countedSpellings--
      removeEntry(token, spelling)
    }
  }

  function applyCounts(source: SpellingCounts, direction: 1 | -1): void {
    for (const [token, byToken] of source) {
      for (const [spelling, count] of byToken) change(token, spelling, count * direction)
    }
  }

  function adoptFields(next: readonly string[]): void {
    if (sameFields(fields, next)) return
    fields = [...next]
    resetSpellings()
    everyDocumentPending = fields.length > 0
  }

  function documentAt(internalId: number): AnyDocument | undefined {
    const docId = view.docStore.getExternalId(internalId)
    return docId === undefined ? undefined : view.docStore.get(docId)?.fields
  }

  function resolvePending(analysis: PartialWordAnalysis): void {
    if (everyDocumentPending) {
      resetSpellings()
      const derived: SpellingCounts = new Map()
      for (const [, stored] of view.docStore.all()) countDocumentSpellings(derived, stored.fields, analysis, 1)
      applyCounts(derived, 1)
      everyDocumentPending = false
      return
    }
    if (pending.size === 0) return
    const derived: SpellingCounts = new Map()
    for (const internalId of pending) {
      const document = documentAt(internalId)
      if (document !== undefined) countDocumentSpellings(derived, document, analysis, 1)
    }
    pending.clear()
    applyCounts(derived, 1)
  }

  const reader: PartialWordReader = {
    forEachContaining(probe: PartialWordProbe, visit: PartialWordVisitor): void {
      const points = probe.codePoints
      if (points.length < PARTIAL_WORD_RUN_CODE_POINTS) return
      let narrowest: Set<number> | null = null
      for (let at = 0; at + PARTIAL_WORD_RUN_CODE_POINTS <= points.length; at++) {
        const members = runs.get(runKeyAt(points, at))
        if (members === undefined) return
        if (narrowest === null || members.size < narrowest.size) narrowest = members
      }
      if (narrowest === null) return
      for (const entry of narrowest) {
        const length = entryLengths[entry]
        if (length <= points.length) continue
        if (!entrySpellings[entry].includes(probe.text)) continue
        visit(entryTokens[entry], length)
      }
    },

    bytes(): number {
      return slot.bytes()
    },
  }

  const slot: GrowingPartialWordSlot = {
    readerFor(analysis: PartialWordAnalysis): PartialWordReader | null {
      if (analysis.fields.length === 0) return null
      adoptFields(analysis.fields)
      resolvePending(analysis)
      return reader
    },

    spellings(): PartialSpellings | null {
      if (fields.length === 0 || everyDocumentPending || pending.size > 0) return null
      return encodePartialSpellings(fields, counts)
    },

    afterDocument(
      documentFields: readonly string[],
      internalId: number,
      spellings: SpellingCounts | null,
      direction: 1 | -1,
    ): void {
      if (documentFields.length === 0) return
      if (!sameFields(fields, documentFields)) {
        const holdsOnlyThisDocument = direction === 1 && view.docStore.count() === 1
        adoptFields(documentFields)
        if (holdsOnlyThisDocument) everyDocumentPending = false
      }
      if (everyDocumentPending) return
      if (direction === -1 && pending.delete(internalId)) return
      if (spellings !== null) {
        applyCounts(spellings, direction)
      } else if (direction === 1) {
        pending.add(internalId)
      } else {
        everyDocumentPending = true
      }
    },

    afterMerge(spellings: PartialSpellings | null, internalIds: readonly number[]): void {
      if (internalIds.length === 0) return
      if (fields.length === 0 && spellings !== null && view.docStore.count() === internalIds.length) {
        adoptFields(spellings.fields)
        everyDocumentPending = false
      }
      if (fields.length === 0 || everyDocumentPending) return
      if (spellings === null || !sameFields(fields, spellings.fields)) {
        for (const internalId of internalIds) pending.add(internalId)
        return
      }
      for (let at = 0; at < spellings.tokens.length; at++) {
        change(spellings.tokens[at], spellings.spellings[at], spellings.counts[at])
      }
    },

    forgetSpellings(): void {
      resetSpellings()
      everyDocumentPending = fields.length > 0
    },

    clear(): void {
      fields = []
      everyDocumentPending = false
      resetSpellings()
    },

    bytes(): number {
      return (
        liveEntries * GROWING_PARTIAL_ENTRY_BYTES +
        runs.size * GROWING_PARTIAL_RUN_BYTES +
        runMembers * GROWING_PARTIAL_RUN_MEMBER_BYTES +
        countedSpellings * GROWING_PARTIAL_COUNTED_SPELLING_BYTES
      )
    },
  }

  return slot
}
