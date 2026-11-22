import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ClusterCoordinator, type ClusterNode, createClusterNode, type NodeTransport } from '../../../distribution'
import { createInMemoryCoordinator } from '../../../distribution/coordinator/in-memory'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'
import type { AnyDocument } from '../../../types/schema'
import { waitForSettledReplica } from './cluster-harness'

const INDEX = 'atlas'
const DATA_NODE = 'data-a'
const WITH_VECTORS = { document: { vectors: true } }

function coordinatesOf(i: number): number[] {
  return [Math.fround(i / 8), Math.fround(-i / 16), Math.fround(0.5 + i / 1024)]
}

function mapOf(i: number): AnyDocument {
  return {
    title: `harbour chart ${i}`,
    embedding: new Float32Array(coordinatesOf(i)),
    meta: { sketch: new Float32Array(coordinatesOf(i + 1)) },
  }
}

function numbersOf(value: unknown): number[] | null {
  return value instanceof Float32Array || Array.isArray(value) ? Array.from(value as ArrayLike<number>) : null
}

function expectStored(document: AnyDocument | undefined, i: number, title: string): void {
  expect(document?.title).toBe(title)
  expect(numbersOf(document?.embedding)).toEqual(coordinatesOf(i))
  expect(numbersOf((document?.meta as Record<string, unknown> | undefined)?.sketch)).toEqual(coordinatesOf(i + 1))
}

describe('a Float32Array vector that a node forwards to the primary', () => {
  const transports: NodeTransport[] = []
  const nodes: ClusterNode[] = []
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let router: ClusterNode

  async function start(nodeId: string, roles: Array<'data' | 'coordinator' | 'controller'>): Promise<ClusterNode> {
    const transport = createInMemoryTransport(nodeId, network)
    transports.push(transport)
    const node = await createClusterNode({
      coordinator,
      transport,
      address: `${nodeId}:9200`,
      nodeId,
      roles,
      engine: { workers: { enabled: false } },
    })
    await node.start()
    nodes.push(node)
    return node
  }

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    await start(DATA_NODE, ['data'])
    router = await start('router', ['coordinator', 'controller'])
    await router.createIndex(
      INDEX,
      { schema: { title: 'string', embedding: 'vector[3]', meta: { sketch: 'vector[3]' } } },
      { partitionCount: 2, replicationFactor: 0 },
    )
    await waitForSettledReplica(coordinator, INDEX, DATA_NODE)
  }, 30_000)

  afterEach(async () => {
    for (const node of nodes.splice(0)) await node.shutdown()
    for (const transport of transports.splice(0)) await transport.shutdown()
    await coordinator.shutdown()
  })

  it('stores the vector values from a forwarded insert, update, and batch', async () => {
    await router.insert(INDEX, mapOf(1), 'chart-1')
    expectStored(await router.get(INDEX, 'chart-1', WITH_VECTORS), 1, 'harbour chart 1')

    await router.update(INDEX, 'chart-1', { ...mapOf(5), title: 'harbour chart revised' })
    expectStored(await router.get(INDEX, 'chart-1', WITH_VECTORS), 5, 'harbour chart revised')

    const ids = Array.from({ length: 6 }, (_, i) => `chart-batch-${i}`)
    const inserted = await router.insertBatch(
      INDEX,
      ids.map((id, i) => ({ id, ...mapOf(10 + i) })),
    )
    expect(inserted.failed).toEqual([])
    expect([...inserted.succeeded].sort()).toEqual([...ids].sort())
    const read = await router.getMultiple(INDEX, ids, WITH_VECTORS)
    for (const [position, id] of ids.entries())
      expectStored(read.get(id), 10 + position, `harbour chart ${10 + position}`)

    const nearest = await router.query(INDEX, { vector: { field: 'embedding', value: coordinatesOf(12) }, limit: 1 })
    expect(nearest.hits.map(hit => hit.id)).toEqual(['chart-batch-2'])
  }, 30_000)
})
