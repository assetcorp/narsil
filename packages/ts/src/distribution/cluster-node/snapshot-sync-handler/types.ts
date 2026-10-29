import type { Narsil } from '../../../narsil'
import type { ClusterCoordinator } from '../../coordinator/types'
import type { SnapshotBuildResult, SnapshotCacheState } from '../snapshot-cache'
import type { SingleResponseSink, SnapshotHeaderMetadata } from '../snapshot-stream-writer'

export type SnapshotSyncHandlerState = SnapshotCacheState

export interface SnapshotSyncHandlerDeps {
  nodeId: string
  engine: Narsil
  coordinator: ClusterCoordinator
  state: SnapshotSyncHandlerState
}

export interface SnapshotSyncStreamOptions {
  metadata: SnapshotHeaderMetadata
  buildSnapshot: (indexName: string) => Promise<SnapshotBuildResult>
  afterSnapshot: (sink: SingleResponseSink, build: SnapshotBuildResult) => Promise<void>
}
