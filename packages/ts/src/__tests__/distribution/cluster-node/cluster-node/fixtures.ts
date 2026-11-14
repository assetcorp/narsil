import type { ClusterNodeConfig } from '../../../../distribution/cluster-node/types'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
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
