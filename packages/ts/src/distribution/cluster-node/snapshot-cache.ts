import { ErrorCodes, NarsilError } from '../../errors'

export const DEFAULT_MAX_CONCURRENT_SNAPSHOTS = 2

export const DEFAULT_MAX_PER_SOURCE_SNAPSHOTS = 1

export interface SnapshotBuildResult {
  bytes: Uint8Array
  checksum: number
}

interface SnapshotInFlightEntry {
  promise: Promise<SnapshotBuildResult>
}

export interface SnapshotCacheState {
  cache: Map<string, SnapshotInFlightEntry>
  active: number
  perSource: Map<string, number>
  maxConcurrent: number
  maxPerSource: number
}

export function createSnapshotCacheState(
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT_SNAPSHOTS,
  maxPerSource: number = DEFAULT_MAX_PER_SOURCE_SNAPSHOTS,
): SnapshotCacheState {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'maxConcurrent must be a positive integer', {
      maxConcurrent,
    })
  }
  if (!Number.isInteger(maxPerSource) || maxPerSource <= 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'maxPerSource must be a positive integer', {
      maxPerSource,
    })
  }
  return {
    cache: new Map(),
    active: 0,
    perSource: new Map(),
    maxConcurrent,
    maxPerSource,
  }
}

export interface SourceSlotHandle {
  sourceId: string
  released: boolean
}

export function acquireSourceSlot(state: SnapshotCacheState, sourceId: string): SourceSlotHandle {
  const current = state.perSource.get(sourceId) ?? 0
  if (current >= state.maxPerSource) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED,
      `snapshot producer per-source cap reached for '${sourceId}'`,
      { sourceId, cap: state.maxPerSource },
    )
  }
  state.perSource.set(sourceId, current + 1)
  return { sourceId, released: false }
}

export function releaseSourceSlot(state: SnapshotCacheState, handle: SourceSlotHandle): void {
  if (handle.released) {
    return
  }
  handle.released = true
  const current = state.perSource.get(handle.sourceId)
  if (current === undefined) {
    return
  }
  if (current <= 1) {
    state.perSource.delete(handle.sourceId)
    return
  }
  state.perSource.set(handle.sourceId, current - 1)
}

export type SnapshotBuilder = () => Promise<SnapshotBuildResult>

/**
 * Best-effort single-flight coordination. Concurrent requesters observed before
 * the in-flight build resolves share one build. The in-flight slot is cleared
 * the moment the build settles so any later requester triggers a fresh build.
 * Memory peak: each concurrent participant in a single build holds one
 * reference to the same Uint8Array; separate builds each own their own bytes.
 */
export async function acquireSnapshotBuild(
  state: SnapshotCacheState,
  indexName: string,
  builder: SnapshotBuilder,
): Promise<SnapshotBuildResult> {
  const existing = state.cache.get(indexName)
  if (existing !== undefined) {
    return existing.promise
  }

  if (state.active >= state.maxConcurrent) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED,
      'snapshot producer capacity exhausted; retry later',
      { active: state.active, max: state.maxConcurrent },
    )
  }

  state.active += 1

  let settled = false
  const clearEntry = (currentEntry: SnapshotInFlightEntry): void => {
    if (settled) {
      return
    }
    settled = true
    const current = state.cache.get(indexName)
    if (current === currentEntry) {
      state.cache.delete(indexName)
    }
    state.active = Math.max(0, state.active - 1)
  }

  const rawBuild: Promise<SnapshotBuildResult> = (async () => builder())()
  const entry: SnapshotInFlightEntry = { promise: rawBuild }
  entry.promise = rawBuild.then(
    result => {
      clearEntry(entry)
      return result
    },
    err => {
      clearEntry(entry)
      throw err
    },
  )
  state.cache.set(indexName, entry)

  return entry.promise
}
