import type { IndexMetadata } from '../../../../../distribution/cluster/controller'
import { putIndexMetadata } from '../../../../../distribution/cluster/controller'
import type {
  AllocationConstraints,
  AllocationTable,
  ClusterCoordinator,
  NodeRegistration,
  PartitionAssignment,
} from '../../../../../distribution/coordinator/types'
import type { SchemaDefinition } from '../../../../../types/schema'

export const defaultConstraints: AllocationConstraints = {
  zoneAwareness: false,
  zoneAttribute: 'zone',
  maxShardsPerNode: null,
}

export const testSchema: SchemaDefinition = {
  title: 'string',
  body: 'string',
}

export function makeNode(nodeId: string): NodeRegistration {
  return {
    nodeId,
    address: `${nodeId}.cluster.local:9200`,
    roles: ['data', 'coordinator', 'controller'],
    capacity: { memoryBytes: 8_000_000_000, cpuCores: 4, diskBytes: null },
    startedAt: '2026-04-09T00:00:00Z',
    version: '1.0',
  }
}

export function makeIndexMetadata(indexName: string, partitionCount = 3, replicationFactor = 1): IndexMetadata {
  return {
    indexName,
    partitionCount,
    replicationFactor,
    constraints: defaultConstraints,
  }
}

export function makeAllocationTable(indexName: string, nodeIds: string[], partitionCount = 3): AllocationTable {
  const assignments = new Map<number, PartitionAssignment>()
  for (let p = 0; p < partitionCount; p++) {
    const primaryIdx = p % nodeIds.length
    const replicaIdx = (p + 1) % nodeIds.length
    assignments.set(p, {
      primary: nodeIds[primaryIdx],
      replicas: primaryIdx !== replicaIdx ? [nodeIds[replicaIdx]] : [],
      inSyncSet: primaryIdx !== replicaIdx ? [nodeIds[replicaIdx]] : [],
      state: 'ACTIVE',
      primaryTerm: 1,
    })
  }
  return {
    indexName,
    version: 1,
    replicationFactor: 1,
    assignments,
  }
}

export async function setupIndexWithAllocation(
  coordinator: ClusterCoordinator,
  indexName: string,
  nodeIds: string[],
  partitionCount = 3,
  replicationFactor = 1,
): Promise<void> {
  await putIndexMetadata(coordinator, makeIndexMetadata(indexName, partitionCount, replicationFactor))
  await coordinator.putAllocation(indexName, makeAllocationTable(indexName, nodeIds, partitionCount))
}

export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>(resolve => {
      process.nextTick(resolve)
    })
  }
}
