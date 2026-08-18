import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport, TransportMessage } from '../../../distribution/transport/types'
import { ReplicationMessageTypes } from '../../../distribution/transport/types'

const POLL_INTERVAL_MS = 25
const POLL_BUDGET_MS = 15_000

async function pollUntil(predicate: () => Promise<boolean> | boolean): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
}

function recordingTransport(inner: NodeTransport, recordedTypes: string[]): NodeTransport {
  return {
    send: (target: string, message: TransportMessage) => {
      recordedTypes.push(message.type)
      return inner.send(target, message)
    },
    stream: (target: string, message: TransportMessage, handler: (chunk: Uint8Array) => void) =>
      inner.stream(target, message, handler),
    listen: handler => inner.listen(handler),
    shutdown: () => inner.shutdown(),
  }
}

describe('cluster-node updates replicate to replicas', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeA: ClusterNode | undefined
  let nodeB: ClusterNode | undefined
  let transportA: NodeTransport
  let transportB: NodeTransport

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transportA = createInMemoryTransport('node-a', network)
    transportB = createInMemoryTransport('node-b', network)

    nodeA = await createClusterNode({
      coordinator,
      transport: transportA,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    await nodeA.start()
    await nodeA.createIndex('products', { schema: { title: 'string', price: 'number' } })

    nodeB = await createClusterNode({
      coordinator,
      transport: transportB,
      address: 'node-b:9200',
      nodeId: 'node-b',
      roles: ['data'],
    })
    await nodeB.start()

    const inSync = await pollUntil(async () => {
      const table = await coordinator.getAllocation('products')
      if (table === null || table.assignments.size === 0) return false
      for (const assignment of table.assignments.values()) {
        if (assignment.state !== 'ACTIVE' || !assignment.inSyncSet.includes('node-b')) return false
      }
      return true
    })
    expect(inSync).toBe(true)
  }, 30_000)

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

  it('replicates a single update to the replica as a full document', async () => {
    if (nodeA === undefined || nodeB === undefined) throw new Error('nodes are missing')

    await nodeA.insert('products', { title: 'Original Kettle', price: 20 }, 'kettle-1')
    await nodeA.update('products', 'kettle-1', { title: 'Replacement Kettle', price: 25 })

    const local = await nodeA.get('products', 'kettle-1')
    expect(local?.title).toBe('Replacement Kettle')

    const replicated = await pollUntil(async () => {
      const viaReplica = await nodeB?.query('products', { term: 'Replacement' })
      return viaReplica?.count === 1
    })
    expect(replicated).toBe(true)

    const oldTermGone = await nodeB.query('products', { term: 'Original' })
    expect(oldTermGone.count).toBe(0)
  }, 30_000)

  it('replicates a batch of updates as entry batches', async () => {
    if (nodeA === undefined || nodeB === undefined) throw new Error('nodes are missing')

    const docIds = Array.from({ length: 12 }, (_, index) => `desk-${index}`)
    const inserted = await nodeA.insertBatch(
      'products',
      docIds.map(id => ({ id, title: `Seeded Desk ${id}`, price: 50 })),
    )
    expect(inserted.failed).toEqual([])

    const updated = await nodeA.updateBatch(
      'products',
      docIds.map(id => ({ docId: id, document: { title: `Refreshed Desk ${id}`, price: 55 } })),
    )
    expect(updated.failed).toEqual([])
    expect(updated.succeeded).toHaveLength(docIds.length)

    const refreshed = await pollUntil(async () => {
      const viaReplica = await nodeB?.query('products', { term: 'Refreshed', limit: 20 })
      return viaReplica?.count === docIds.length
    })
    expect(refreshed).toBe(true)
  }, 30_000)

  it('rejects an update for a document that does not exist', async () => {
    if (nodeA === undefined) throw new Error('node is missing')
    await expect(nodeA.update('products', 'missing-doc', { title: 'Ghost', price: 1 })).rejects.toThrow()
  }, 30_000)
})

describe('cluster-node batch forwarding to a remote primary', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let router: ClusterNode | undefined
  let dataNode: ClusterNode | undefined
  let routerTransport: NodeTransport
  let dataTransport: NodeTransport
  let recordedTypes: string[]

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    recordedTypes = []
    routerTransport = recordingTransport(createInMemoryTransport('router', network), recordedTypes)
    dataTransport = createInMemoryTransport('holder', network)

    dataNode = await createClusterNode({
      coordinator,
      transport: dataTransport,
      address: 'holder:9200',
      nodeId: 'holder',
      roles: ['data'],
    })
    await dataNode.start()

    router = await createClusterNode({
      coordinator,
      transport: routerTransport,
      address: 'router:9200',
      nodeId: 'router',
      roles: ['coordinator', 'controller'],
    })
    await router.start()

    await router.createIndex(
      'products',
      { schema: { title: 'string', price: 'number' } },
      { partitionCount: 4, replicationFactor: 0 },
    )

    const active = await pollUntil(async () => {
      const table = await coordinator.getAllocation('products')
      if (table === null || table.assignments.size === 0) return false
      for (const assignment of table.assignments.values()) {
        if (assignment.state !== 'ACTIVE' || assignment.primary !== 'holder') return false
      }
      return true
    })
    expect(active).toBe(true)
  }, 30_000)

  afterEach(async () => {
    if (router !== undefined) {
      await router.shutdown()
      router = undefined
    }
    if (dataNode !== undefined) {
      await dataNode.shutdown()
      dataNode = undefined
    }
    await routerTransport.shutdown()
    await dataTransport.shutdown()
    await coordinator.shutdown()
  })

  it('forwards an insert batch as one message and a single insert as a plain forward', async () => {
    if (router === undefined || dataNode === undefined) throw new Error('nodes are missing')

    const docIds = Array.from({ length: 10 }, (_, index) => `chair-${index}`)
    recordedTypes.length = 0
    const inserted = await router.insertBatch(
      'products',
      docIds.map(id => ({ id, title: `Batched Chair ${id}`, price: 40 })),
    )
    expect(inserted.failed).toEqual([])
    expect(inserted.succeeded).toHaveLength(docIds.length)
    expect(recordedTypes.filter(type => type === ReplicationMessageTypes.FORWARD_BATCH)).toHaveLength(1)
    expect(recordedTypes.filter(type => type === ReplicationMessageTypes.FORWARD)).toHaveLength(0)

    recordedTypes.length = 0
    await router.insert('products', { title: 'Solo Chair', price: 41 }, 'chair-solo')
    expect(recordedTypes.filter(type => type === ReplicationMessageTypes.FORWARD)).toHaveLength(1)
    expect(recordedTypes.filter(type => type === ReplicationMessageTypes.FORWARD_BATCH)).toHaveLength(0)

    const visible = await router.query('products', { term: 'Chair', limit: 20 })
    expect(visible.count).toBe(docIds.length + 1)
  }, 30_000)

  it('forwards updates and removals in batches and applies them on the primary', async () => {
    if (router === undefined || dataNode === undefined) throw new Error('nodes are missing')

    const docIds = Array.from({ length: 8 }, (_, index) => `stool-${index}`)
    const inserted = await router.insertBatch(
      'products',
      docIds.map(id => ({ id, title: `Seeded Stool ${id}`, price: 10 })),
    )
    expect(inserted.failed).toEqual([])

    recordedTypes.length = 0
    const updated = await router.updateBatch(
      'products',
      docIds.map(id => ({ docId: id, document: { title: `Refreshed Stool ${id}`, price: 12 } })),
    )
    expect(updated.failed).toEqual([])
    expect(updated.succeeded).toHaveLength(docIds.length)
    expect(recordedTypes.filter(type => type === ReplicationMessageTypes.FORWARD_BATCH)).toHaveLength(1)
    expect(recordedTypes.filter(type => type === ReplicationMessageTypes.FORWARD)).toHaveLength(0)

    const refreshed = await router.query('products', { term: 'Refreshed', limit: 20 })
    expect(refreshed.count).toBe(docIds.length)

    recordedTypes.length = 0
    const removed = await router.removeBatch('products', docIds)
    expect(removed.failed).toEqual([])
    expect(removed.succeeded).toHaveLength(docIds.length)
    expect(recordedTypes.filter(type => type === ReplicationMessageTypes.FORWARD_BATCH)).toHaveLength(1)
    expect(recordedTypes.filter(type => type === ReplicationMessageTypes.FORWARD)).toHaveLength(0)

    const emptied = await router.query('products', { term: 'Stool', limit: 20 })
    expect(emptied.count).toBe(0)
  }, 30_000)

  it('forwards a single remote update as a plain forward and reports remote failures per document', async () => {
    if (router === undefined) throw new Error('node is missing')

    await router.insert('products', { title: 'Lone Bench', price: 60 }, 'bench-1')
    recordedTypes.length = 0
    await router.update('products', 'bench-1', { title: 'Restored Bench', price: 65 })
    expect(recordedTypes.filter(type => type === ReplicationMessageTypes.FORWARD)).toHaveLength(1)

    const mixed = await router.updateBatch('products', [
      { docId: 'bench-1', document: { title: 'Polished Bench', price: 70 } },
      { docId: 'bench-missing', document: { title: 'Ghost Bench', price: 1 } },
    ])
    expect(mixed.succeeded).toEqual(['bench-1'])
    expect(mixed.failed).toHaveLength(1)
    expect(mixed.failed[0]?.docId).toBe('bench-missing')
    expect(mixed.failed[0]?.error.code).toBe('DOC_NOT_FOUND')
  }, 30_000)
})
