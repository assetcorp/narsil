import type { ClusterCoordinator } from '../../coordinator/types'
import type { RespondFn, TransportMessage } from '../../transport/types'
import type { AllocationView } from '../allocation-view'
import type { ClusterLocalEngine } from '../local-engine'
import type { SnapshotHeaderMetadataProvider, SnapshotSyncHandlerState } from '../snapshot-sync-handler'
import type { WriteRoutingDeps } from '../write-routing'
export type TransportHandler = (message: TransportMessage, respond: RespondFn) => void | Promise<void>

export interface DataNodeHandlerDeps {
  nodeId: string
  engine: ClusterLocalEngine
  coordinator: ClusterCoordinator
  allocations?: Pick<AllocationView, 'read' | 'refresh'>
  writeDeps: WriteRoutingDeps
  snapshotSyncState: SnapshotSyncHandlerState
  snapshotSpoolDirectory?: string
  resolveHeaderMetadata?: SnapshotHeaderMetadataProvider
  isBootstrapSynced?: (indexName: string, partitionId: number) => boolean
}
