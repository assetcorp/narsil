import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport, type InMemoryNetwork } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'

const POLL_INTERVAL_MS = 25
const POLL_BUDGET_MS = 15_000

export async function waitForActiveAllocation(
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<AllocationTable> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    const allocation = await coordinator.getAllocation(indexName)
    if (allocation !== null && allocation.assignments.size > 0) {
      const allActive = [...allocation.assignments.values()].every(assignment => assignment.state === 'ACTIVE')
      if (allActive) return allocation
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`allocation for ${indexName} never became active`)
}

export interface SingleNodeCluster {
  coordinator: ClusterCoordinator
  network: InMemoryNetwork
  transport: NodeTransport
  node: ClusterNode
  shutdown(): Promise<void>
}

export async function startSingleNodeCluster(): Promise<SingleNodeCluster> {
  const coordinator = createInMemoryCoordinator()
  const network = createInMemoryNetwork()
  const transport = createInMemoryTransport('node-a', network)
  const node = await createClusterNode({
    coordinator,
    transport,
    address: 'node-a:9200',
    nodeId: 'node-a',
    roles: ['data', 'coordinator', 'controller'],
  })
  await node.start()
  return {
    coordinator,
    network,
    transport,
    node,
    async shutdown() {
      await node.shutdown()
      await transport.shutdown()
      await coordinator.shutdown()
    },
  }
}
