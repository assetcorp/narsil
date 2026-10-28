import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator } from '../../../distribution/coordinator/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'

const INDEX_NAME = 'harbours'
const PARTITION_COUNT = 6
const FIRST_NODES = ['quay-a', 'quay-b']
const ARRIVING_NODE = 'quay-c'
const DOCUMENT_TOTAL = 120
const ALLOCATION_WAIT_MS = 20_000

type Harbour = { id: string; title: string }

function harbours(): Harbour[] {
  return Array.from({ length: DOCUMENT_TOTAL }, (_, index) => ({
    id: `harbour-${index}`,
    title: `tidal berth ${index}`,
  }))
}

function inSyncReplicaCount(table: AllocationTable, partitionId: number): number {
  const assignment = table.assignments.get(partitionId)
  if (assignment === undefined) return 0
  return assignment.replicas.filter(replica => assignment.inSyncSet.includes(replica)).length
}

function settled(table: AllocationTable): boolean {
  return [...table.assignments.values()].every(
    entry =>
      entry.state === 'ACTIVE' &&
      entry.primary !== null &&
      entry.replicas.length === 1 &&
      entry.replicas.every(replica => entry.inSyncSet.includes(replica)),
  )
}

describe('a replica that the controller moves to a node that joins', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  const running: ClusterNode[] = []
  let router: ClusterNode

  async function startDataNode(nodeId: string): Promise<void> {
    const node = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport(nodeId, network),
      address: `${nodeId}:9200`,
      nodeId,
      roles: ['data'],
    })
    running.push(node)
    await node.start()
  }

  async function waitForAllocation(done: (table: AllocationTable) => boolean): Promise<AllocationTable> {
    const deadline = Date.now() + ALLOCATION_WAIT_MS
    let last: AllocationTable | null = null
    while (Date.now() < deadline) {
      last = await coordinator.getAllocation(INDEX_NAME)
      if (last !== null && done(last)) return last
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`the allocation never settled; last seen ${JSON.stringify([...(last?.assignments ?? [])])}`)
  }

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    for (const nodeId of FIRST_NODES) await startDataNode(nodeId)
    router = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport('harbour-master', network),
      address: 'harbour-master:9200',
      nodeId: 'harbour-master',
      roles: ['coordinator', 'controller'],
    })
    running.push(router)
    await router.start()
    await router.createIndex(
      INDEX_NAME,
      { schema: { title: 'string' } },
      { partitionCount: PARTITION_COUNT, replicationFactor: 1 },
    )
    await waitForAllocation(settled)
    expect((await router.insertBatch(INDEX_NAME, harbours())).failed).toEqual([])
  })

  afterEach(async () => {
    for (const node of running.splice(0).reverse()) await node.shutdown().catch(() => {})
    await coordinator.shutdown()
  })

  it('keeps every partition at its in-sync replica count until the new copy has caught up', async () => {
    const shortfalls: string[] = []
    const stopWatching = await coordinator.watchAllocation(event => {
      if (event.indexName !== INDEX_NAME) return
      for (const partitionId of event.table.assignments.keys()) {
        if (inSyncReplicaCount(event.table, partitionId) < 1) {
          shortfalls.push(`partition ${partitionId} at version ${event.table.version}`)
        }
      }
    })

    try {
      await startDataNode(ARRIVING_NODE)
      const balanced = await waitForAllocation(
        table =>
          settled(table) &&
          [...table.assignments.values()].some(
            entry => entry.primary === ARRIVING_NODE || entry.replicas.includes(ARRIVING_NODE),
          ),
      )
      expect(balanced.assignments.size).toBe(PARTITION_COUNT)
    } finally {
      stopWatching()
    }

    expect(shortfalls).toEqual([])
    const expected = harbours()
    const read = await router.getMultiple(
      INDEX_NAME,
      expected.map(harbour => harbour.id),
    )
    expect(new Map([...read].map(([id, document]) => [id, document.title]))).toEqual(
      new Map(expected.map(harbour => [harbour.id, harbour.title])),
    )
  }, 60_000)
})
