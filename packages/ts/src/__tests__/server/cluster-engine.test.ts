import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../distribution/cluster-node'
import { clusterNodeEngine } from '../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../distribution/coordinator'
import type { ClusterCoordinator } from '../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport } from '../../distribution/transport'
import type { NodeTransport } from '../../distribution/transport/types'
import type { NarsilServer } from '../../server'
import { createServer } from '../../server'
import { del, getJson, patchJson, postJson } from './helpers'

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

describe('the HTTP server serves a cluster node', () => {
  let coordinator: ClusterCoordinator
  let transport: NodeTransport
  let node: ClusterNode
  let server: NarsilServer
  let base: string

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    const network = createInMemoryNetwork()
    transport = createInMemoryTransport('node-a', network)
    node = await createClusterNode({
      coordinator,
      transport,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    await node.start()
    server = createServer(clusterNodeEngine(node), { host: '127.0.0.1', port: 0 })
    await server.listen()
    base = `http://127.0.0.1:${server.listeningPort}`
  })

  afterEach(async () => {
    await server.close()
    await node.shutdown()
    await transport.shutdown()
    await coordinator.shutdown()
  })

  it('creates, writes, searches, and reads through the cluster, and refuses the rest with 501', async () => {
    const created = await postJson(base, '/indexes', {
      name: 'products',
      config: { schema: { title: 'string', price: 'number' } },
    })
    expect(created.status).toBe(201)

    const allocated = await pollUntil(async () => {
      const allocation = await coordinator.getAllocation('products')
      if (allocation === null || allocation.assignments.size === 0) return false
      for (const assignment of allocation.assignments.values()) {
        if (assignment.state !== 'ACTIVE') return false
      }
      return true
    })
    expect(allocated).toBe(true)

    const inserted = await postJson<{ id: string }>(base, '/indexes/products/documents', {
      document: { title: 'Clustered Widget', price: 12 },
      id: 'widget-1',
    })
    expect(inserted.status).toBe(201)

    const search = await postJson<{ count: number; hits: Array<{ id: string }> }>(base, '/indexes/products/search', {
      term: 'clustered',
    })
    expect(search.status).toBe(200)
    expect(search.body.count).toBe(1)
    expect(search.body.hits[0]?.id).toBe('widget-1')

    const fetched = await getJson<{ document: { title: string } }>(base, '/indexes/products/documents/widget-1')
    expect(fetched.status).toBe(200)

    const exists = await getJson<{ exists: boolean }>(base, '/indexes/products/documents/widget-1/_exists')
    expect(exists.status).toBe(200)

    const removed = await del(base, '/indexes/products/documents/widget-1')
    expect(removed.status).toBe(200)

    const refusals: Array<[string, Promise<{ status: number; body: unknown }>]> = [
      ['patch document', patchJson(base, '/indexes/products/documents/widget-2', { document: { title: 'x' } })],
      ['suggest', postJson(base, '/indexes/products/suggest', { prefix: 'clu' })],
      ['preflight', postJson(base, '/indexes/products/search/preflight', { term: 'clustered' })],
      ['list indexes', getJson(base, '/indexes')],
      ['index stats', getJson(base, '/indexes/products/stats')],
      ['drop index', del(base, '/indexes/products')],
      ['memory stats', getJson(base, '/stats/memory')],
      ['checkpoint', postJson(base, '/indexes/products/_checkpoint', {})],
    ]
    for (const [operation, request] of refusals) {
      const refusal = await request
      expect(refusal.status, operation).toBe(501)
      expect((refusal.body as { error: { code: string } }).error.code, operation).toBe('CLUSTER_OPERATION_UNSUPPORTED')
    }
  })
})
