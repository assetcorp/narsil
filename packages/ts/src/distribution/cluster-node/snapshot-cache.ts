import { ErrorCodes, NarsilError } from '../../errors'
import type { SpooledSnapshot } from '../replication/snapshot-spool'
import { DEFAULT_MAX_PER_SOURCE_SNAPSHOTS, DEFAULT_MAX_STREAMS_PER_INDEX } from './constants'

export interface SnapshotBuildResult extends SpooledSnapshot {
  lastSeqNo?: number
  primaryTerm?: number
}

export interface SnapshotCacheState {
  perSource: Map<string, number>
  streamActive: Map<string, number>
  maxPerSource: number
  maxStreamsPerIndex: number
}

export function createSnapshotCacheState(
  maxPerSource: number = DEFAULT_MAX_PER_SOURCE_SNAPSHOTS,
  maxStreamsPerIndex: number = DEFAULT_MAX_STREAMS_PER_INDEX,
): SnapshotCacheState {
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
    perSource: new Map(),
    streamActive: new Map(),
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
