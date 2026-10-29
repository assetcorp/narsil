import type { Narsil } from '../../../narsil'
import type { ClusterCoordinator } from '../../coordinator/types'
import type { SnapshotBuildResult, SnapshotCacheState } from '../snapshot-cache'
import type { SingleResponseSink } from '../snapshot-stream-writer'

export type SnapshotSyncHandlerState = SnapshotCacheState

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
  spoolDirectory?: string
  indexUuidOf?: (indexName: string) => string | null | undefined
}

export interface SnapshotSyncStreamOptions {
  metadata?: SnapshotHeaderMetadata
  closeOnEnd?: boolean
  afterSnapshot?: (sink: SingleResponseSink, build: SnapshotBuildResult) => void | Promise<void>
  disableBuildCache?: boolean
  buildSnapshot?: (indexName: string) => Promise<SnapshotBuildResult> | SnapshotBuildResult
}
