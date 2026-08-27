import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'

const INDEX_NAME = 'shop'
const DOCUMENT_TOTAL = 24

function shopDocuments(): Array<Record<string, unknown>> {
  return Array.from({ length: DOCUMENT_TOTAL }, (_, index) => ({
    id: `item-${index}`,
    title: `portable grinder ${index}`,
    price: index,
  }))
}

async function waitForAllocation(
  coordinator: ClusterCoordinator,
  settled: (table: AllocationTable) => boolean,
): Promise<AllocationTable> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const table = await coordinator.getAllocation(INDEX_NAME)
    if (table !== null && settled(table)) {
      return table
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the allocation never reached the expected shape')
}

describe('a node that holds the controller lease recovering a partition it still holds', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transport: NodeTransport
  let node: ClusterNode

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transport = createInMemoryTransport('node-a', network)
    node = await createClusterNode({
      coordinator,
      transport,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    await node.start()
    await node.createIndex(INDEX_NAME, { schema: { title: 'string', price: 'number' } })
    const inserted = await node.insertBatch(INDEX_NAME, shopDocuments())
    expect(inserted.failed).toEqual([])
  }, 30_000)

  afterEach(async () => {
    await node.shutdown()
    await transport.shutdown()
    await coordinator.shutdown()
  })

  it('promotes itself back to primary of a partition its own copy still holds', async () => {
    const served = await waitForAllocation(coordinator, table =>
      [...table.assignments.values()].every(assignment => assignment.primary !== null),
    )

    const orphaned = new Map<number, PartitionAssignment>()
    for (const [partitionId, assignment] of served.assignments) {
      orphaned.set(partitionId, {
        ...assignment,
        primary: null,
        replicas: [],
        inSyncSet: [],
        lastHolders: ['node-a'],
        state: 'UNASSIGNED',
      })
    }
    expect(
      await coordinator.putAllocation(
        INDEX_NAME,
        { ...served, version: served.version + 1, assignments: orphaned },
        served.version,
      ),
    ).toBe(true)

    const recovered = await waitForAllocation(coordinator, table =>
      [...table.assignments.values()].some(assignment => assignment.primary === 'node-a'),
    )

    const restored = [...recovered.assignments.values()].filter(assignment => assignment.primary === 'node-a')
    expect(restored.length).toBeGreaterThan(0)
    for (const assignment of restored) {
      expect(assignment.primaryTerm).toBeGreaterThan(1)
    }

    const backInService = await waitForAllocation(coordinator, table =>
      [...table.assignments.values()].every(assignment => assignment.state === 'ACTIVE'),
    )
    expect([...backInService.assignments.values()].every(assignment => assignment.primary === 'node-a')).toBe(true)

    const answered = await node.query(INDEX_NAME, { term: 'portable', limit: DOCUMENT_TOTAL })
    expect(answered.hits).toHaveLength(DOCUMENT_TOTAL)
    expect(answered.coverage.failedPartitions).toBe(0)
  }, 30_000)
})
