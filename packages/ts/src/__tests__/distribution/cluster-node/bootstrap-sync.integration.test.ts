import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'

const POLL_INTERVAL_MS = 25
const POLL_BUDGET_MS = 15_000

async function pollUntil(predicate: () => Promise<boolean> | boolean, budgetMs = POLL_BUDGET_MS): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    const result = await predicate()
    if (result) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
}

const PRODUCT_DOCUMENTS = [
  { title: 'Ergo Keyboard', description: 'split mechanical keyboard with tactile switches', price: 199.0 },
  { title: 'Standing Desk', description: 'electric adjustable standing desk', price: 499.0 },
  { title: 'Monitor Arm', description: 'gas spring monitor arm with clamp mount', price: 89.99 },
  { title: 'USB Hub', description: 'seven port USB C hub with passthrough charging', price: 59.0 },
  { title: 'Webcam 4K', description: 'ultra high definition webcam with ring light', price: 129.0 },
  { title: 'Noise Cancelling Headphones', description: 'over ear wireless headphones', price: 349.0 },
  { title: 'Desk Lamp', description: 'dimmable LED desk lamp with wireless charging base', price: 79.0 },
  { title: 'Ergonomic Mouse', description: 'vertical ergonomic mouse with six buttons', price: 65.0 },
  { title: 'Laptop Stand', description: 'aluminium laptop stand with adjustable height', price: 45.0 },
  { title: 'Cable Tray', description: 'under desk cable management tray', price: 29.99 },
]

describe('bootstrap sync integration', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeA: ClusterNode | undefined
  let nodeB: ClusterNode | undefined
  let transportA: NodeTransport
  let transportB: NodeTransport

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transportA = createInMemoryTransport('node-a', network)
    transportB = createInMemoryTransport('node-b', network)
  })

  afterEach(async () => {
    if (nodeA !== undefined) {
      await nodeA.shutdown()
      nodeA = undefined
    }
    if (nodeB !== undefined) {
      await nodeB.shutdown()
      nodeB = undefined
    }
    await transportA.shutdown()
    await transportB.shutdown()
    await coordinator.shutdown()
  })

  it('new replica pulls a snapshot from the primary and serves the documents locally', async () => {
    nodeA = await createClusterNode({
      coordinator,
      transport: transportA,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    await nodeA.start()

    await nodeA.createIndex('products', {
      schema: { title: 'string', description: 'string', price: 'number' },
    })

    const docIds: string[] = []
    for (const doc of PRODUCT_DOCUMENTS) {
      const id = await nodeA.insert('products', doc)
      docIds.push(id)
    }

    nodeB = await createClusterNode({
      coordinator,
      transport: transportB,
      address: 'node-b:9200',
      nodeId: 'node-b',
      roles: ['data'],
    })
    await nodeB.start()

    const ready = await pollUntil(async () => {
      const allocation = await coordinator.getAllocation('products')
      if (allocation === null || allocation.assignments.size === 0) {
        return false
      }
      for (const assignment of allocation.assignments.values()) {
        if (!assignment.inSyncSet.includes('node-b')) {
          return false
        }
        if (assignment.state !== 'ACTIVE') {
          return false
        }
      }
      return true
    })

    expect(ready).toBe(true)

    const result = await nodeB.query('products', { term: 'keyboard' })
    expect(result.count).toBeGreaterThanOrEqual(1)
    const titles = result.hits.map(hit => (hit.document as { title?: string }).title)
    expect(titles).toContain('Ergo Keyboard')
  })
})
