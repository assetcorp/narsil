import type { AnyDocument } from '../../types/schema'
import { SPEC_VERSION } from '../cluster/version'
import type { AllocationTable, NodeRegistration, NodeRole } from '../coordinator/types'
import type { ReplicationLog } from '../replication/types'
import { type AllocationView, createAllocationView } from './allocation-view'
import { createCatchUpState } from './catch-up'
import type { ClusterLocalEngine } from './local-engine'
import { createNodeMemoryReporting } from './memory/node-memory'
import { readDistributedDocuments, resolveNodeTargets as resolveTargetsForNode } from './node-messaging'
import {
  getReplicationLog as readReplicationLog,
  replicationLogKey,
  seedReplicationLog as writeSeededReplicationLog,
} from './replication-logs'
import type { ReshardState } from './reshard/state'
import type { ClusterNodeConfig } from './types'
import { DEFAULT_CAPACITY } from './types'
import type { WriteRoutingDeps } from './write-routing'
import { createPrimaryNumbering } from './write-routing/numbering'
import { createPartitionWriteQueues } from './write-routing/partition-queue'

export interface NodeWiring {
  registration: NodeRegistration
  allocationView: AllocationView
  routingConfig: ClusterNodeConfig
  memoryReporting: ReturnType<typeof createNodeMemoryReporting>
  writeDeps: WriteRoutingDeps
  getReplicationLog: (indexName: string, partitionId: number) => ReplicationLog
  seedReplicationLog: (indexName: string, partitionId: number, startSeqNo: number, lastPrimaryTerm?: number) => void
  existingReplicationLog: (indexName: string, partitionId: number) => ReplicationLog | undefined
  resolveNodeTargets: (targetNodeId: string) => Promise<string[]>
}

export function createNodeWiring(input: {
  config: ClusterNodeConfig
  nodeId: string
  roles: ReadonlyArray<NodeRole>
  engine: ClusterLocalEngine
  replicationLogs: Map<string, ReplicationLog>
  reshard: ReshardState
  renewRegistration: () => void
}): NodeWiring {
  const { config, nodeId, engine, replicationLogs } = input

  function getReplicationLog(indexName: string, partitionId: number): ReplicationLog {
    return readReplicationLog(replicationLogs, indexName, partitionId, config.replication, engine.persistedPositionOf)
  }

  function seedReplicationLog(indexName: string, partitionId: number, startSeqNo: number, lastPrimaryTerm = 0): void {
    writeSeededReplicationLog(replicationLogs, indexName, partitionId, startSeqNo, lastPrimaryTerm, config.replication)
  }

  const allocationView = createAllocationView(config.coordinator)
  const routingConfig: ClusterNodeConfig = { ...config, coordinator: allocationView.routing }

  async function resolveNodeTargets(targetNodeId: string): Promise<string[]> {
    return resolveTargetsForNode(routingConfig, targetNodeId)
  }

  async function readPrimaryCopies(indexName: string, docIds: readonly string[]): Promise<Map<string, AnyDocument>> {
    const table = await allocationView.refresh(indexName)
    if (table === null) return new Map()
    const primariesOnly: AllocationTable = {
      ...table,
      assignments: new Map(
        [...table.assignments].map(([partitionId, assignment]) => [
          partitionId,
          { ...assignment, replicas: [], inSyncSet: [] },
        ]),
      ),
    }
    return readDistributedDocuments(routingConfig, nodeId, engine, indexName, docIds, primariesOnly)
  }

  const registration: NodeRegistration = {
    nodeId,
    address: config.address,
    roles: [...input.roles],
    capacity: config.capacity ?? DEFAULT_CAPACITY,
    startedAt: new Date().toISOString(),
    version: SPEC_VERSION,
  }

  const memoryReporting = createNodeMemoryReporting({
    registration,
    engine,
    coordinator: config.coordinator,
    config: config.memory,
    onFullChange: input.renewRegistration,
  })

  const numbering = createPrimaryNumbering()
  engine.numberEntriesWith(numbering.numberEntry, numbering.defersCommit)
  engine.admitWritesWith(numbering.admit)
  const writeDeps: WriteRoutingDeps = {
    nodeId,
    numbering,
    commitPartitionLog: engine.commitPartitionLog,
    coordinator: allocationView.routing,
    refreshAllocation: allocationView.refresh,
    readLiveAllocation: allocationView.readLive,
    readPrimaryCopies,
    engine,
    transport: config.transport,
    getReplicationLog,
    resetReplicationLog: seedReplicationLog,
    partitionWriteQueues: createPartitionWriteQueues(),
    catchUp: createCatchUpState(),
    resolveNodeTargets,
    waitForActiveReplicas: config.replication?.waitForActiveReplicas,
    memoryView: memoryReporting.view,
    writePressure: memoryReporting.writePressure,
    writeProjection: memoryReporting.writeProjection,
    reshard: input.reshard,
  }

  return {
    registration,
    allocationView,
    routingConfig,
    memoryReporting,
    writeDeps,
    getReplicationLog,
    seedReplicationLog,
    existingReplicationLog: (indexName, partitionId) => replicationLogs.get(replicationLogKey(indexName, partitionId)),
    resolveNodeTargets,
  }
}
