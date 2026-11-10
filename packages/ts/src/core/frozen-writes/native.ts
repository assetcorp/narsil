import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { NativeCore } from '../../vector/native/types'
import type { NativeFrozenPagedRemovals } from '../../vector/native/types/frozen-segments'
import * as portable from './portable'
import type { FrozenPagedRemovals, PrepareFrozenRemoval, RemoveFrozenDocument, SettleFrozenState } from './types'

export { growFrozenRemovalRegions } from './pending-writes'
export { prepareFrozenStrings } from './removal-strings'

const PAGE_CORRUPT = 9
const PAGE_INVALID = 11

function nativeCore(): NativeCore | null {
  if (!nativeSearchCoreIsEnabled()) return null
  const core = loadNativeCore()
  if (core === null) noteFallback('removeFrozenDocument')
  return core
}

function sectionsOf(paged: FrozenPagedRemovals | null): NativeFrozenPagedRemovals | null | undefined {
  if (paged === null) return null
  return paged.native() ?? undefined
}

function pageStatus(status: number, paged: FrozenPagedRemovals | null): number {
  const magnitude = Math.abs(status)
  if (paged !== null && magnitude >= PAGE_CORRUPT && magnitude <= PAGE_INVALID) paged.fail(-magnitude)
  return status
}

export const removeFrozenDocument: RemoveFrozenDocument = (segment, state, ordinal, fields, paged) => {
  const core = nativeCore()
  const sections = core === null ? undefined : sectionsOf(paged)
  if (core === null || sections === undefined) {
    return portable.removeFrozenDocument(segment, state, ordinal, fields, paged)
  }
  const { terms, surfaces, spellings, removalIndex } = segment
  const status = core.removeFrozenDocument(
    segment.documentCount,
    terms.text,
    terms.offsets,
    terms.counts,
    surfaces?.text ?? null,
    surfaces?.offsets ?? null,
    surfaces?.counts ?? null,
    spellings?.text ?? null,
    spellings?.offsets ?? null,
    spellings?.counts ?? null,
    segment.payloadSlots,
    segment.postingOffsets,
    segment.postingDocuments,
    segment.postingFrequencies,
    segment.postingFields,
    segment.partialFields,
    segment.spellingTokens,
    removalIndex?.starts ?? null,
    removalIndex?.rows ?? null,
    removalIndex?.termOfSlot ?? null,
    state.tombstones,
    state.tombstoneCount,
    state.removedDocuments,
    state.removedOccurrences,
    state.removedSurfaces,
    state.removedSpellings,
    state.pendingHeader,
    state.pendingDocuments,
    state.pendingTokens,
    state.pendingUnits,
    ordinal,
    fields,
    sections,
  )
  return pageStatus(status, paged)
}

export const prepareFrozenRemoval: PrepareFrozenRemoval = (segment, state, ordinal, fields, entries, values, paged) => {
  const core = nativeCore()
  const sections = core === null ? undefined : sectionsOf(paged)
  if (core === null || sections === undefined) {
    return portable.prepareFrozenRemoval(segment, state, ordinal, fields, entries, values, paged)
  }
  const { terms, surfaces, spellings, removalIndex } = segment
  const status = core.prepareFrozenRemoval(
    segment.documentCount,
    terms.text,
    terms.offsets,
    terms.counts,
    surfaces?.text ?? null,
    surfaces?.offsets ?? null,
    surfaces?.counts ?? null,
    spellings?.text ?? null,
    spellings?.offsets ?? null,
    spellings?.counts ?? null,
    segment.payloadSlots,
    segment.postingOffsets,
    segment.postingDocuments,
    segment.postingFrequencies,
    segment.postingFields,
    segment.partialFields,
    segment.spellingTokens,
    removalIndex?.starts ?? null,
    removalIndex?.rows ?? null,
    removalIndex?.termOfSlot ?? null,
    state.tombstones,
    state.tombstoneCount,
    state.removedDocuments,
    state.removedOccurrences,
    state.removedSurfaces,
    state.removedSpellings,
    state.pendingHeader,
    state.pendingDocuments,
    state.pendingTokens,
    state.pendingUnits,
    ordinal,
    fields,
    entries,
    values,
    sections,
  )
  return pageStatus(status, paged)
}

export const settleFrozenState: SettleFrozenState = (segment, state, paged) => {
  const core = nativeCore()
  const sections = core === null ? undefined : sectionsOf(paged)
  if (core === null || sections === undefined) return portable.settleFrozenState(segment, state, paged)
  const { terms, surfaces, spellings, removalIndex } = segment
  const status = core.settleFrozenState(
    segment.documentCount,
    terms.text,
    terms.offsets,
    terms.counts,
    surfaces?.text ?? null,
    surfaces?.offsets ?? null,
    surfaces?.counts ?? null,
    spellings?.text ?? null,
    spellings?.offsets ?? null,
    spellings?.counts ?? null,
    segment.payloadSlots,
    segment.postingOffsets,
    segment.postingDocuments,
    segment.postingFrequencies,
    segment.postingFields,
    segment.partialFields,
    segment.spellingTokens,
    removalIndex?.starts ?? null,
    removalIndex?.rows ?? null,
    removalIndex?.termOfSlot ?? null,
    state.tombstones,
    state.tombstoneCount,
    state.removedDocuments,
    state.removedOccurrences,
    state.removedSurfaces,
    state.removedSpellings,
    state.pendingHeader,
    state.pendingDocuments,
    state.pendingTokens,
    state.pendingUnits,
    sections,
  )
  return pageStatus(status, paged)
}
