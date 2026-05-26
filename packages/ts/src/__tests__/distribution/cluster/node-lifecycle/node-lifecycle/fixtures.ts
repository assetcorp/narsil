import type {
  AllocationTable,
  NodeRegistration,
  PartitionAssignment,
} from '../../../../../distribution/coordinator/types'

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

export function makeAllocationTable(
  indexName: string,
  assignments: Map<number, PartitionAssignment>,
  version = 1,
): AllocationTable {
  return { indexName, version, replicationFactor: 1, assignments }
}

export function makeAssignment(overrides: Partial<PartitionAssignment> = {}): PartitionAssignment {
  return {
    primary: 'primary-node',
    replicas: [],
    inSyncSet: [],
    state: 'INITIALISING',
    primaryTerm: 1,
    ...overrides,
  }
}

export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>(resolve => {
      process.nextTick(resolve)
    })
  }
}
