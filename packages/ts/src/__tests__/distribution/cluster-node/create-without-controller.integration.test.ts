import { afterEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import { waitForSettledReplica } from './cluster-harness'

const POLL_INTERVAL_MS = 25
const POLL_BUDGET_MS = 15_000
const INDEX = 'bookings'

async function insertOnceServing(node: ClusterNode, id: string, document: Record<string, unknown>): Promise<unknown> {
  const start = Date.now()
  let lastError: unknown = null
  while (Date.now() - start < POLL_BUDGET_MS) {
    try {
      await node.insert(INDEX, document, id)
      return null
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return lastError
}

describe('an index created while no controller holds the lease', () => {
  const nodes: ClusterNode[] = []
  const transports: NodeTransport[] = []
  let coordinator: ClusterCoordinator | undefined

  afterEach(async () => {
    for (const node of nodes.splice(0)) await node.shutdown()
    for (const transport of transports.splice(0)) await transport.shutdown()
    await coordinator?.shutdown()
    coordinator = undefined
  })

  it('takes writes once a controller joins, and serves them from every node', async () => {
    coordinator = createInMemoryCoordinator()
    const network = createInMemoryNetwork()
    async function startNode(nodeId: string, roles: Array<'data' | 'coordinator' | 'controller'>) {
      if (coordinator === undefined) throw new Error('the coordinator never started')
      const transport = createInMemoryTransport(nodeId, network)
      transports.push(transport)
      const node = await createClusterNode({ coordinator, transport, address: `${nodeId}:9200`, nodeId, roles })
      nodes.push(node)
      await node.start()
      return node
    }

    const router = await startNode('node-a', ['data', 'coordinator'])
    await router.createIndex(INDEX, { schema: { guest: 'string', nights: 'number' } }, { replicationFactor: 1 })
    const controller = await startNode('node-b', ['data', 'coordinator', 'controller'])

    const documents = new Map([
      ['booking-1', { guest: 'Ama Mensah', nights: 3 }],
      ['booking-2', { guest: 'Kofi Boateng', nights: 1 }],
    ])
    for (const [id, document] of documents) {
      expect(await insertOnceServing(router, id, document)).toBeNull()
    }
    if (coordinator === undefined) throw new Error('the coordinator stopped')
    await waitForSettledReplica(coordinator, INDEX, 'node-a')
    await waitForSettledReplica(coordinator, INDEX, 'node-b')

    for (const node of [router, controller]) {
      expect(await node.countDocuments(INDEX)).toBe(documents.size)
      const stored = await node.getMultiple(INDEX, [...documents.keys(), 'booking-3'])
      expect(
        new Map([...stored].map(([id, document]) => [id, { guest: document.guest, nights: document.nights }])),
      ).toEqual(documents)
    }
  }, 40_000)
})
