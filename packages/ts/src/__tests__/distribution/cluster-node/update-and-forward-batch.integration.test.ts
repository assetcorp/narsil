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
const PARTITION_COUNT = 4

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
    send: async (target: string, message: TransportMessage) => {
      const response = await inner.send(target, message)
      recordedTypes.push(message.type)
      return response
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
      { partitionCount: PARTITION_COUNT, replicationFactor: 0 },
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
