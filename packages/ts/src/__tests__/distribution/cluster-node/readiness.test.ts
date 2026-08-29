import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode, NodeReadiness } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import { makeAllocationTable, makeAssignment } from '../query/routing/fixtures'

const INDEX_NAME = 'shop'
const NODE_ID = 'node-a'
const ABSENT_PRIMARY = 'node-z'
const POLL_INTERVAL_MS = 25
const POLL_BUDGET_MS = 5_000
const WATCH_SETTLE_MS = 600
const ALLOCATION_RETRY_SETTLE_MS = 2_500

async function readinessReaches(node: ClusterNode, expected: NodeReadiness): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    if (node.cluster.getReadiness() === expected) return true
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return node.cluster.getReadiness() === expected
}

describe('the readiness a data node reports', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transport: NodeTransport
  let node: ClusterNode

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transport = createInMemoryTransport(NODE_ID, network)
    node = await createClusterNode({
      coordinator,
      transport,
      address: `${NODE_ID}:9200`,
      nodeId: NODE_ID,
      roles: ['data', 'coordinator'],
    })
  })

  afterEach(async () => {
    await node.shutdown()
    await transport.shutdown()
    await coordinator.shutdown()
  })

  it('moves from STARTING through SERVING to LEAVING when it holds no partition', async () => {
    expect(node.cluster.getReadiness()).toBe('STARTING')

    await node.start()
    expect(node.cluster.getReadiness()).toBe('SERVING')

    await node.shutdown()
    expect(node.cluster.getReadiness()).toBe('LEAVING')
  })

  it('reports JOINING from the moment it starts while the coordinator assigns it a partition it has yet to serve', async () => {
    await coordinator.putSchema(INDEX_NAME, { title: 'string' })
    const table = makeAllocationTable(
      [[0, makeAssignment({ primary: ABSENT_PRIMARY, replicas: [NODE_ID], inSyncSet: [], state: 'ACTIVE' })]],
      INDEX_NAME,
    )
    expect(await coordinator.putAllocation(INDEX_NAME, table, null)).toBe(true)

    await node.start()

    expect(node.cluster.getReadiness()).toBe('JOINING')
  })

  it('keeps reporting SERVING while a partition it leads migrates or decommissions', async () => {
    await node.start()
    await coordinator.putSchema(INDEX_NAME, { title: 'string' })

    const migrating = makeAllocationTable(
      [
        [0, makeAssignment({ primary: NODE_ID, inSyncSet: [], state: 'MIGRATING' })],
        [1, makeAssignment({ primary: NODE_ID, inSyncSet: [], state: 'DECOMMISSIONING' })],
      ],
      INDEX_NAME,
    )
    expect(await coordinator.putAllocation(INDEX_NAME, migrating, null)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, WATCH_SETTLE_MS))

    expect(node.cluster.getReadiness()).toBe('SERVING')
  })

  it('returns to JOINING once the controller gives a SERVING node another partition', async () => {
    await node.start()
    await coordinator.putSchema(INDEX_NAME, { title: 'string' })

    const initialising = makeAllocationTable(
      [[0, makeAssignment({ primary: NODE_ID, inSyncSet: [], state: 'INITIALISING' })]],
      INDEX_NAME,
    )
    expect(await coordinator.putAllocation(INDEX_NAME, initialising, null)).toBe(true)
    expect(await readinessReaches(node, 'JOINING')).toBe(true)

    const serving = makeAllocationTable(
      [[0, makeAssignment({ primary: NODE_ID, inSyncSet: [], state: 'ACTIVE' })]],
      INDEX_NAME,
    )
    expect(await coordinator.putAllocation(INDEX_NAME, { ...serving, version: 2 }, 1)).toBe(true)
    expect(await readinessReaches(node, 'SERVING')).toBe(true)

    const widened = makeAllocationTable(
      [
        [0, makeAssignment({ primary: NODE_ID, inSyncSet: [], state: 'ACTIVE' })],
        [1, makeAssignment({ primary: ABSENT_PRIMARY, replicas: [NODE_ID], inSyncSet: [], state: 'ACTIVE' })],
      ],
      INDEX_NAME,
    )
    expect(await coordinator.putAllocation(INDEX_NAME, { ...widened, version: 3 }, 2)).toBe(true)
    expect(await readinessReaches(node, 'JOINING')).toBe(true)
  })
})

describe('the readiness a node reports between registering and serving', () => {
  it('is JOINING from the moment its registration is written', async () => {
    const backing = createInMemoryCoordinator()
    let releaseRegistration: () => void = () => undefined
    const registrationGate = new Promise<void>(resolve => {
      releaseRegistration = resolve
    })
    let markRegistered: () => void = () => undefined
    const registered = new Promise<void>(resolve => {
      markRegistered = resolve
    })
    const coordinator: ClusterCoordinator = {
      ...backing,
      async listSchemas() {
        markRegistered()
        await registrationGate
        return backing.listSchemas()
      },
    }
    const network = createInMemoryNetwork()
    const transport = createInMemoryTransport(NODE_ID, network)
    const node = await createClusterNode({
      coordinator,
      transport,
      address: `${NODE_ID}:9200`,
      nodeId: NODE_ID,
      roles: ['data', 'coordinator'],
    })
    try {
      const starting = node.start()
      await registered
      expect(node.cluster.getReadiness()).toBe('JOINING')
      releaseRegistration()
      await starting
      expect(node.cluster.getReadiness()).toBe('SERVING')
    } finally {
      releaseRegistration()
      await node.shutdown()
      await transport.shutdown()
      await coordinator.shutdown()
    }
  })
})

describe('the readiness a node without the data role reports', () => {
  it('is SERVING once it holds a registration', async () => {
    const coordinator = createInMemoryCoordinator()
    const network = createInMemoryNetwork()
    const transport = createInMemoryTransport('router', network)
    const router = await createClusterNode({
      coordinator,
      transport,
      address: 'router:9200',
      nodeId: 'router',
      roles: ['coordinator'],
    })
    try {
      expect(router.cluster.getReadiness()).toBe('STARTING')
      await router.start()
      expect(router.cluster.getReadiness()).toBe('SERVING')
      expect((await coordinator.listNodes()).map(registration => registration.nodeId)).toEqual(['router'])
    } finally {
      await router.shutdown()
      await transport.shutdown()
      await coordinator.shutdown()
    }
  })
})

describe('a controller with no data node registered', () => {
  it('reports no allocation failure while an index waits for a data node', async () => {
    const coordinator = createInMemoryCoordinator()
    const network = createInMemoryNetwork()
    const transport = createInMemoryTransport('controller', network)
    const failures: string[] = []
    const controller = await createClusterNode({
      coordinator,
      transport,
      address: 'controller:9200',
      nodeId: 'controller',
      roles: ['controller', 'coordinator'],
      onError: error => failures.push(error.message),
    })
    try {
      await controller.start()
      await controller.createIndex(INDEX_NAME, { schema: { title: 'string' } }, { waitForServingMs: 0 })
      await new Promise(resolve => setTimeout(resolve, ALLOCATION_RETRY_SETTLE_MS))
      expect(failures).toEqual([])
      expect(await coordinator.getAllocation(INDEX_NAME)).toBeNull()
    } finally {
      await controller.shutdown()
      await transport.shutdown()
      await coordinator.shutdown()
    }
  })
})
