import type { NarsilError } from '../../../errors'
import type { Narsil } from '../../../narsil'
import type { SchemaDefinition } from '../../../types/schema'
import type { ClusterCoordinator } from '../../coordinator/types'
import type { createSnapshotStreamState } from '../../replication/snapshot-stream-assembler'
import type { ReplicationLog, ReplicationLogEntry } from '../../replication/types'
import type { NodeTransport, ReplicationSnapshotHeader, SyncEntriesPayload } from '../../transport/types'
import type { ABORT_SENTINEL } from '../bootstrap-restore'

export interface BootstrapEntry {
  indexName: string
  partitionId: number
  generation: number
  promise: Promise<boolean>
  aborted: boolean
  abortResolve: () => void
  abortPromise: Promise<typeof ABORT_SENTINEL>
}

export interface BootstrapSyncState {
  inFlight: Map<string, BootstrapEntry>
  completed: Set<string>
  generations: Map<string, number>
}

export interface BootstrapSyncDeps {
  engine: Narsil
  coordinator: ClusterCoordinator
  transport: NodeTransport
  sourceNodeId: string
  resolveNodeTargets: (nodeId: string) => Promise<string[]>
  onError?: (error: unknown) => void
  onSnapshotApplied?: (indexName: string, partitionId: number, header: ReplicationSnapshotHeader) => void
  getReplicationLog?: (indexName: string, partitionId: number) => ReplicationLog
  resetReplicationLog?: (indexName: string, partitionId: number, startSeqNo: number, lastPrimaryTerm?: number) => void
  applyReplicationEntry?: (entry: ReplicationLogEntry) => Promise<void>
  restoreReplicationPartition?: (
    indexName: string,
    partitionId: number,
    bytes: Uint8Array,
    schema: SchemaDefinition,
    partitionCount: number,
  ) => Promise<void>
  deadlineMs?: number
}

export interface LiveBootstrapSyncDeps extends BootstrapSyncDeps {
  getReplicationLog: (indexName: string, partitionId: number) => ReplicationLog
  resetReplicationLog: (indexName: string, partitionId: number, startSeqNo: number, lastPrimaryTerm?: number) => void
  applyReplicationEntry: (entry: ReplicationLogEntry) => Promise<void>
  restoreReplicationPartition: (
    indexName: string,
    partitionId: number,
    bytes: Uint8Array,
    schema: SchemaDefinition,
    partitionCount: number,
  ) => Promise<void>
}

export type AbortCheck = () => boolean

export interface LiveSyncSuccess {
  ok: true
  tier: 'incremental' | 'snapshot'
  entriesApplied: number
  newSeqNo: number
  snapshotHeader: ReplicationSnapshotHeader | null
}

export type LiveSyncResult = LiveSyncSuccess | { ok: false; error: NarsilError }

export interface LocalLogState {
  lastSeqNo: number
  lastPrimaryTerm: number
}

export interface LiveSyncFrameState {
  snapshotState: ReturnType<typeof createSnapshotStreamState>
  syncEntries: SyncEntriesPayload[]
  sawSnapshotFrame: boolean
  error: NarsilError | null
}

export interface ApplyEntriesSuccess {
  ok: true
  entriesApplied: number
  newSeqNo: number
}

export type ApplyEntriesResult = ApplyEntriesSuccess | { ok: false; error: NarsilError }
