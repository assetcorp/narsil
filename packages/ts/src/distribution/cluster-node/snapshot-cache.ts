import { ErrorCodes, NarsilError } from '../../errors'

export const DEFAULT_MAX_CONCURRENT_SNAPSHOTS = 2

export const DEFAULT_MAX_PER_SOURCE_SNAPSHOTS = 1

export const DEFAULT_MAX_STREAMS_PER_INDEX = 4

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
  streamActive: Map<string, number>
  maxConcurrent: number
  maxPerSource: number
  maxStreamsPerIndex: number
}

export function createSnapshotCacheState(
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT_SNAPSHOTS,
  maxPerSource: number = DEFAULT_MAX_PER_SOURCE_SNAPSHOTS,
  maxStreamsPerIndex: number = DEFAULT_MAX_STREAMS_PER_INDEX,
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
  if (!Number.isInteger(maxStreamsPerIndex) || maxStreamsPerIndex <= 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'maxStreamsPerIndex must be a positive integer', {
      maxStreamsPerIndex,
    })
  }
  return {
    cache: new Map(),
    active: 0,
    perSource: new Map(),
    streamActive: new Map(),
    maxConcurrent,
    maxPerSource,
    maxStreamsPerIndex,
  }
}

export interface SourceSlotHandle {
  key: string
  released: boolean
}

function sourceSlotKey(sourceId: string, indexName: string): string {
  return `${sourceId}\u0000${indexName}`
}

export function acquireSourceSlot(state: SnapshotCacheState, sourceId: string, indexName: string): SourceSlotHandle {
  const key = sourceSlotKey(sourceId, indexName)
  const current = state.perSource.get(key) ?? 0
  if (current >= state.maxPerSource) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED,
      `snapshot producer per-source cap reached for '${sourceId}' index '${indexName}'`,
      { sourceId, indexName, cap: state.maxPerSource },
    )
  }
  state.perSource.set(key, current + 1)
  return { key, released: false }
}

export function releaseSourceSlot(state: SnapshotCacheState, handle: SourceSlotHandle): void {
  if (handle.released) {
    return
  }
  handle.released = true
  const current = state.perSource.get(handle.key)
  if (current === undefined) {
    return
  }
  if (current <= 1) {
    state.perSource.delete(handle.key)
    return
  }
  state.perSource.set(handle.key, current - 1)
}

export interface StreamSlotHandle {
  indexName: string
  released: boolean
}

export function acquireStreamSlot(state: SnapshotCacheState, indexName: string): StreamSlotHandle {
  const current = state.streamActive.get(indexName) ?? 0
  if (current >= state.maxStreamsPerIndex) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED,
      `snapshot stream fan-out cap reached for index '${indexName}'`,
      { indexName, cap: state.maxStreamsPerIndex },
    )
  }
  state.streamActive.set(indexName, current + 1)
  return { indexName, released: false }
}

export function releaseStreamSlot(state: SnapshotCacheState, handle: StreamSlotHandle): void {
  if (handle.released) {
    return
  }
  handle.released = true
  const current = state.streamActive.get(handle.indexName)
  if (current === undefined) {
    return
  }
  if (current <= 1) {
    state.streamActive.delete(handle.indexName)
    return
  }
  state.streamActive.set(handle.indexName, current - 1)
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
