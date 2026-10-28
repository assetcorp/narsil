import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator, NodeRegistration } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport, type InMemoryNetwork } from '../../../distribution/transport'

const INDEX_NAME = 'lanterns'
const PARTITION_COUNT = 4
const FOREIGN_NODE = 'keeper-next'
const ALLOCATION_WAIT_MS = 20_000

function foreignRegistration(version: string): NodeRegistration {
  return {
    nodeId: FOREIGN_NODE,
    address: `${FOREIGN_NODE}:9200`,
    roles: ['data'],
    capacity: { memoryBytes: 64_000_000_000, cpuCores: 32, diskBytes: 1_000_000_000_000 },
    startedAt: '2026-10-01T00:00:00.000Z',
    version,
  }
}

function holders(table: AllocationTable): string[] {
  const named = new Set<string>()
  for (const entry of table.assignments.values()) {
    if (entry.primary !== null) named.add(entry.primary)
    for (const replica of entry.replicas) named.add(replica)
  }
  return [...named].sort()
}

describe('a node that registers on another major version', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  const running: ClusterNode[] = []

  async function start(nodeId: string, roles: Array<'data' | 'coordinator' | 'controller'>): Promise<ClusterNode> {
    const node = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport(nodeId, network),
      address: `${nodeId}:9200`,
      nodeId,
      roles,
    })
    running.push(node)
    await node.start()
    return node
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

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
  })

  afterEach(async () => {
    for (const node of running.splice(0).reverse()) await node.shutdown().catch(() => {})
    await coordinator.shutdown()
  })

  it.each([
    ['2.0'],
    ['0.9'],
    ['10.0'],
    ['banana'],
    [''],
  ])('never gives a partition to a node on version %j', async version => {
    await start('keeper-a', ['data'])
    const router = await start('lamp-room', ['coordinator', 'controller'])
    await coordinator.registerNode(foreignRegistration(version))

    await router.createIndex(
      INDEX_NAME,
      { schema: { title: 'string' } },
      { partitionCount: PARTITION_COUNT, replicationFactor: 1, waitForServingMs: 0 },
    )
    const table = await waitForAllocation(current =>
      [...current.assignments.values()].every(entry => entry.primary !== null),
    )

    expect(holders(table)).toEqual(['keeper-a'])
  }, 30_000)

  it('gives partitions to a node on the same major version and a later minor one', async () => {
    await start('keeper-a', ['data'])
    const router = await start('lamp-room', ['coordinator', 'controller'])
    await coordinator.registerNode(foreignRegistration('1.7'))

    await router.createIndex(
      INDEX_NAME,
      { schema: { title: 'string' } },
      { partitionCount: PARTITION_COUNT, replicationFactor: 1, waitForServingMs: 0 },
    )
    const table = await waitForAllocation(current =>
      [...current.assignments.values()].every(entry => entry.primary !== null && entry.replicas.length === 1),
    )

    expect(holders(table)).toEqual(['keeper-a', FOREIGN_NODE])
  }, 30_000)

  it.each([
    ['2.0'],
    ['0.9'],
    ['banana'],
  ])('refuses to start a node while the active controller follows version %j', async version => {
    await coordinator.registerNode(foreignRegistration(version))
    expect(await coordinator.acquireLease('_narsil/controller', FOREIGN_NODE, 60_000)).toBe(true)

    const node = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport('keeper-a', network),
      address: 'keeper-a:9200',
      nodeId: 'keeper-a',
      roles: ['data'],
    })
    running.push(node)

    await expect(node.start()).rejects.toMatchObject({ code: 'NODE_VERSION_INCOMPATIBLE' })
    const registered = (await coordinator.listNodes()).map(entry => entry.nodeId)
    expect(registered).toEqual([FOREIGN_NODE])
  })

  it('starts a node while the active controller follows a later minor version', async () => {
    await coordinator.registerNode(foreignRegistration('1.7'))
    expect(await coordinator.acquireLease('_narsil/controller', FOREIGN_NODE, 60_000)).toBe(true)

    await start('keeper-a', ['data'])

    const registered = (await coordinator.listNodes()).map(entry => entry.nodeId).sort()
    expect(registered).toEqual(['keeper-a', FOREIGN_NODE])
  })
})
