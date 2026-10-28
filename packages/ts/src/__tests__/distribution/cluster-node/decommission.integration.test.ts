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

const INDEX_NAME = 'lighthouses'
const PARTITION_COUNT = 6
const DOCUMENT_TOTAL = 90
const ALLOCATION_WAIT_MS = 20_000
const LEAVING_NODE = 'keeper-b'

type Lighthouse = { id: string; title: string }

function lighthouses(): Lighthouse[] {
  return Array.from({ length: DOCUMENT_TOTAL }, (_, index) => ({
    id: `lighthouse-${index}`,
    title: `rocky headland ${index}`,
  }))
}

function inSyncCopies(table: AllocationTable, partitionId: number): number {
  const assignment = table.assignments.get(partitionId)
  if (assignment === undefined || assignment.primary === null) return 0
  return 1 + assignment.replicas.filter(replica => assignment.inSyncSet.includes(replica)).length
}

function names(table: AllocationTable, nodeId: string): boolean {
  return [...table.assignments.values()].some(
    entry =>
      entry.primary === nodeId || entry.replicas.includes(nodeId) || entry.removingReplicas?.includes(nodeId) === true,
  )
}

function settled(table: AllocationTable): boolean {
  return [...table.assignments.values()].every(
    entry =>
      entry.state === 'ACTIVE' &&
      entry.primary !== null &&
      entry.replicas.length === 1 &&
      entry.removingReplicas === undefined &&
      entry.replicas.every(replica => entry.inSyncSet.includes(replica)),
  )
}

describe('a data node that leaves the cluster through decommission', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  const running: ClusterNode[] = []
  const dataNodes = new Map<string, ClusterNode>()
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
    dataNodes.set(nodeId, node)
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

  async function startCluster(dataNodeIds: string[]): Promise<void> {
    for (const nodeId of dataNodeIds) await startDataNode(nodeId)
    router = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport('harbour-office', network),
      address: 'harbour-office:9200',
      nodeId: 'harbour-office',
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
    expect((await router.insertBatch(INDEX_NAME, lighthouses())).failed).toEqual([])
  }

  function leavingNode(): ClusterNode {
    const node = dataNodes.get(LEAVING_NODE)
    if (node === undefined) throw new Error(`${LEAVING_NODE} never started`)
    return node
  }

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    dataNodes.clear()
  })

  afterEach(async () => {
    for (const node of running.splice(0).reverse()) await node.shutdown().catch(() => {})
    await coordinator.shutdown()
  })

  it('moves every copy elsewhere before it deregisters, and never drops a partition below two in-sync copies', async () => {
    await startCluster(['keeper-a', LEAVING_NODE, 'keeper-c'])
    const shortfalls: string[] = []
    const stopWatching = await coordinator.watchAllocation(event => {
      if (event.indexName !== INDEX_NAME) return
      for (const partitionId of event.table.assignments.keys()) {
        if (inSyncCopies(event.table, partitionId) < 2) {
          shortfalls.push(`partition ${partitionId} at version ${event.table.version}`)
        }
      }
    })

    try {
      await leavingNode().decommission()
    } finally {
      stopWatching()
    }

    expect(shortfalls).toEqual([])
    const table = await coordinator.getAllocation(INDEX_NAME)
    expect(table !== null && names(table, LEAVING_NODE)).toBe(false)
    expect((await coordinator.listNodes()).map(node => node.nodeId)).not.toContain(LEAVING_NODE)

    const expected = lighthouses()
    const read = await router.getMultiple(
      INDEX_NAME,
      expected.map(lighthouse => lighthouse.id),
    )
    expect(new Map([...read].map(([id, document]) => [id, document.title]))).toEqual(
      new Map(expected.map(lighthouse => [lighthouse.id, lighthouse.title])),
    )
  }, 60_000)

  it('keeps the node and every copy where no other node can take them, and stops the drain once the caller aborts', async () => {
    await startCluster(['keeper-a', LEAVING_NODE])
    const before = await coordinator.getAllocation(INDEX_NAME)
    const giveUp = new AbortController()
    const reason = new Error('the harbour master called the drain off')

    const drain = leavingNode().decommission({ signal: giveUp.signal })
    const deadline = Date.now() + ALLOCATION_WAIT_MS
    while (!(await coordinator.listNodes()).some(node => node.nodeId === LEAVING_NODE && node.draining === true)) {
      if (Date.now() > deadline) throw new Error('the node never published its drain')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    giveUp.abort(reason)

    await expect(drain).rejects.toBe(reason)
    const registration = (await coordinator.listNodes()).find(node => node.nodeId === LEAVING_NODE)
    expect(registration?.draining).toBeUndefined()
    const after = await waitForAllocation(settled)
    expect(names(after, LEAVING_NODE)).toBe(true)
    expect(after.assignments.size).toBe(before?.assignments.size)
    expect(await router.countDocuments(INDEX_NAME)).toBe(DOCUMENT_TOTAL)
  }, 60_000)
})
