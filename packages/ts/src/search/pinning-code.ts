import { importOptionalReads } from '../engine/optional-reads-code'
import type { QueryParams } from '../types/search'
import { lazyCode } from './lazy-code'
import type * as Pinning from './pinning'

const code = lazyCode('pin placement', importOptionalReads)

export function loadPinningFor(pinned: QueryParams['pinned']): Promise<void> | null {
  return pinned === undefined ? null : code.load()
}

export const placePinned: typeof Pinning.placePinned = (...args) => code.get().placePinned(...args)
export const dedupePinnedEntries: typeof Pinning.dedupePinnedEntries = (...args) =>
  code.get().dedupePinnedEntries(...args)
