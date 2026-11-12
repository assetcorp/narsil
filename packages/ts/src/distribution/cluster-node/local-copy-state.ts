import type { ReplicationLog } from '../replication/types'
import { type BootstrapSyncState, clearBootstrapSyncOfIndex } from './bootstrap-sync'
import { type CatchUpState, forgetCatchUpIndex, forgetOutOfStepRemovalsOfIndex } from './catch-up/state'
import { deleteIndexReplicationLogs } from './replication-logs'
import { forgetReshardIndex, type ReshardState } from './reshard/state'

export interface LocalCopyState {
  replicationLogs: Map<string, ReplicationLog>
  reshard: ReshardState
  bootstrapSync: BootstrapSyncState
  catchUp: () => CatchUpState
}

export function forgetClosedCopy(state: LocalCopyState, indexName: string): void {
  deleteIndexReplicationLogs(state.replicationLogs, indexName)
  forgetReshardIndex(state.reshard, indexName)
  forgetOutOfStepRemovalsOfIndex(state.catchUp(), indexName)
}

export function forgetDroppedCopy(state: LocalCopyState, indexName: string): void {
  forgetClosedCopy(state, indexName)
  clearBootstrapSyncOfIndex(state.bootstrapSync, indexName)
  forgetCatchUpIndex(state.catchUp(), indexName)
}
