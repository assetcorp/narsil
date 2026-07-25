import type { ClusterCoordinator } from '../../coordinator/types'
import type { TransportMessage } from '../../transport/types'
import type { ClusterLocalEngine } from '../local-engine'
import type { SnapshotHeaderMetadataProvider, SnapshotSyncHandlerState } from '../snapshot-sync-handler'
import type { WriteRoutingDeps } from '../write-routing'
export type TransportHandler = (
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
) => void | Promise<void>

export interface DataNodeHandlerDeps {
  nodeId: string
  engine: ClusterLocalEngine
  coordinator: ClusterCoordinator
  writeDeps: WriteRoutingDeps
  snapshotSyncState: SnapshotSyncHandlerState
  resolveHeaderMetadata?: SnapshotHeaderMetadataProvider
  isBootstrapSynced?: (indexName: string, partitionId: number) => boolean
}
