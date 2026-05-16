import type { ClusterNodeConfig } from '../../../../distribution/cluster-node/types'
import type {
  AllocationTable,
  ClusterCoordinator,
  PartitionAssignment,
} from '../../../../distribution/coordinator/types'
import type { NodeTransport } from '../../../../distribution/transport/types'

export function makeConfig(
  overrides: Partial<ClusterNodeConfig> & {
    coordinator: ClusterCoordinator
    transport: NodeTransport
    address: string
  },
): ClusterNodeConfig {
  return {
    roles: ['data', 'coordinator', 'controller'],
    ...overrides,
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
    primary: null,
    replicas: [],
    inSyncSet: [],
    state: 'UNASSIGNED',
    primaryTerm: 1,
    ...overrides,
  }
}
