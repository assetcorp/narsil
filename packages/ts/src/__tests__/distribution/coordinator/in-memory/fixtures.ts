import type { AllocationTable, NodeRegistration, PartitionAssignment } from '../../../../distribution/coordinator'
import type { SchemaDefinition } from '../../../../types/schema'

export function makeNodeRegistration(overrides: Partial<NodeRegistration> = {}): NodeRegistration {
  return {
    nodeId: 'node-1',
    address: '127.0.0.1:9200',
    roles: ['data', 'coordinator', 'controller'],
    capacity: { memoryBytes: 8_000_000_000, cpuCores: 4, diskBytes: 100_000_000_000 },
    startedAt: '2026-04-08T10:00:00Z',
    version: '1.0',
    ...overrides,
  }
}

export function makeAllocationTable(indexName: string): AllocationTable {
  const assignment: PartitionAssignment = {
    primary: 'node-1',
    replicas: ['node-2'],
    inSyncSet: ['node-2'],
    state: 'ACTIVE',
    primaryTerm: 1,
  }
  return {
    indexName,
    version: 1,
    replicationFactor: 1,
    assignments: new Map([[0, assignment]]),
  }
}

export const testSchema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  published: 'boolean',
}
