import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { NativeCore } from '../../vector/native/types'
import type { NativeFrozenPagedRemovals } from '../../vector/native/types/frozen-segments'
import * as portable from './portable'
import type { FrozenPagedRemovals, PrepareFrozenRemoval, RemoveFrozenDocument, SettleFrozenState } from './types'

export { growFrozenRemovalRegions } from './pending-writes'

const PAGE_CORRUPT = 9
const PAGE_INVALID = 11

interface NativeCall {
  core: NativeCore
  paged: NativeFrozenPagedRemovals | null
}

function nativeCall(paged: FrozenPagedRemovals | null): NativeCall | null {
  if (!nativeSearchCoreIsEnabled()) return null
  const core = loadNativeCore()
  if (core === null) {
    noteFallback('removeFrozenDocument')
    return null
  }
  const sections = paged === null ? null : paged.native()
  return paged !== null && sections === null ? null : { core, paged: sections }
}

function pageStatus(status: number, paged: FrozenPagedRemovals | null): number {
  const magnitude = Math.abs(status)
  if (paged !== null && magnitude >= PAGE_CORRUPT && magnitude <= PAGE_INVALID) paged.fail(-magnitude)
  return status
}

export const removeFrozenDocument: RemoveFrozenDocument = (segment, state, ordinal, fields, paged) => {
  const call = nativeCall(paged)
  if (call === null) return portable.removeFrozenDocument(segment, state, ordinal, fields, paged)
  return pageStatus(call.core.removeFrozenDocument(segment, state, ordinal, fields, call.paged), paged)
}

export const prepareFrozenRemoval: PrepareFrozenRemoval = (segment, state, ordinal, fields, entries, values, paged) => {
  const call = nativeCall(paged)
  if (call === null) return portable.prepareFrozenRemoval(segment, state, ordinal, fields, entries, values, paged)
  return pageStatus(call.core.prepareFrozenRemoval(segment, state, ordinal, fields, entries, values, call.paged), paged)
}

export const settleFrozenState: SettleFrozenState = (segment, state, paged) => {
  const call = nativeCall(paged)
  if (call === null) return portable.settleFrozenState(segment, state, paged)
  return pageStatus(call.core.settleFrozenState(segment, state, call.paged), paged)
}
