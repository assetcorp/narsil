import type { Narsil } from '../../../narsil'
import type { ClusterCoordinator } from '../../coordinator/types'
import {
  DEFAULT_MAX_CONCURRENT_SNAPSHOTS,
  DEFAULT_MAX_PER_SOURCE_SNAPSHOTS,
  DEFAULT_MAX_STREAMS_PER_INDEX,
  type SnapshotBuildResult,
  type SnapshotCacheState,
} from '../snapshot-cache'
import type { SingleResponseSink } from '../snapshot-stream-writer'

export type SnapshotSyncHandlerState = SnapshotCacheState

export { DEFAULT_MAX_CONCURRENT_SNAPSHOTS, DEFAULT_MAX_PER_SOURCE_SNAPSHOTS, DEFAULT_MAX_STREAMS_PER_INDEX }

export interface SnapshotHeaderMetadata {
  partitionId: number
  primaryTerm: number
  lastSeqNo: number
}

export type SnapshotHeaderMetadataProvider = (
  indexName: string,
  partitionId: number | null,
) => Promise<SnapshotHeaderMetadata> | SnapshotHeaderMetadata

export interface SnapshotSyncHandlerDeps {
  nodeId: string
  engine: Narsil
  coordinator: ClusterCoordinator
  state: SnapshotSyncHandlerState
  resolveHeaderMetadata?: SnapshotHeaderMetadataProvider
}

export interface SnapshotSyncStreamOptions {
  metadata?: SnapshotHeaderMetadata
  closeOnEnd?: boolean
  afterSnapshot?: (sink: SingleResponseSink) => void | Promise<void>
  disableBuildCache?: boolean
  buildSnapshot?: (indexName: string) => Promise<SnapshotBuildResult> | SnapshotBuildResult
}
