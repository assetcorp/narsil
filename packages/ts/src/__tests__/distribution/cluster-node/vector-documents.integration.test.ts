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

const INDEX = 'shelves'
const DATA_NODES = ['data-a', 'data-b']

function embeddingOf(i: number): number[] {
  return [Math.fround(i / 7), Math.fround(-i / 11), Math.fround(0.25 + i / 1000)]
}

function expectStoredVectors(document: AnyDocument | undefined, i: number): void {
  expect(document?.embedding).toBeInstanceOf(Float32Array)
  expect(Array.from(document?.embedding as Float32Array)).toEqual(embeddingOf(i))
  const nested = (document?.meta as Record<string, unknown> | undefined)?.sketch
  expect(nested).toBeInstanceOf(Float32Array)
  expect(Array.from(nested as Float32Array)).toEqual(embeddingOf(i + 1))
}

describe('vector fields in documents that other nodes hold', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transports: NodeTransport[]
  let nodes: ClusterNode[]
  let router: ClusterNode

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transports = []
    nodes = []
    for (const nodeId of DATA_NODES) {
      const transport = createInMemoryTransport(nodeId, network)
      transports.push(transport)
      const node = await createClusterNode({
        coordinator,
        transport,
        address: `${nodeId}:9200`,
        nodeId,
        roles: ['data'],
      })
      await node.start()
      nodes.push(node)
    }
    const routerTransport = createInMemoryTransport('router', network)
    transports.push(routerTransport)
    router = await createClusterNode({
      coordinator,
      transport: routerTransport,
      address: 'router:9200',
      nodeId: 'router',
      roles: ['coordinator', 'controller'],
    })
    await router.start()
    nodes.push(router)
    await router.createIndex(
      INDEX,
      { schema: { title: 'string', embedding: 'vector[3]', meta: { sketch: 'vector[3]' } } },
      { partitionCount: 4, replicationFactor: 1 },
    )
    for (const nodeId of DATA_NODES) await waitForSettledReplica(coordinator, INDEX, nodeId)
    const inserted = await router.insertBatch(
      INDEX,
      Array.from({ length: 12 }, (_, i) => ({
        id: `book-${i}`,
        title: `lantern book ${i}`,
        embedding: embeddingOf(i),
        meta: { sketch: embeddingOf(i + 1) },
      })),
    )
    expect(inserted.failed).toEqual([])
  }, 30_000)

  afterEach(async () => {
    for (const node of nodes) await node.shutdown()
    for (const transport of transports) await transport.shutdown()
    await coordinator.shutdown()
  })

  const indexOf = (id: string): number => Number(id.slice('book-'.length))

  const everyId = Array.from({ length: 12 }, (_, i) => `book-${i}`)

  it('returns each vector as the engine stores it, from a search, a read by ID, and a listing that ask for vectors', async () => {
    const withVectors = { vectors: true }
    const searched = await router.query(INDEX, { term: 'lantern', limit: 12, document: withVectors })
    expect(searched.hits).toHaveLength(12)
    for (const hit of searched.hits) expectStoredVectors(hit.document, indexOf(hit.id))

    const read = await router.getMultiple(INDEX, everyId, { document: withVectors })
    expect(read.size).toBe(12)
    for (const [id, document] of read) expectStoredVectors(document, indexOf(id))
    expectStoredVectors(await router.get(INDEX, 'book-5', { document: withVectors }), 5)

    const listed = await router.listDocuments(INDEX, { limit: 12, document: withVectors })
    expect(listed.documents).toHaveLength(12)
    for (const entry of listed.documents) expectStoredVectors(entry.document, indexOf(entry.id))
  }, 30_000)

  it('leaves every vector field out of a search, a read by ID, and a listing that do not ask for vectors', async () => {
    const documents: Array<[string, AnyDocument | undefined]> = [
      ...(await router.query(INDEX, { term: 'lantern', limit: 12 })).hits.map(
        hit => [hit.id, hit.document] as [string, AnyDocument],
      ),
      ...(await router.getMultiple(INDEX, everyId)),
      ['book-5', await router.get(INDEX, 'book-5')],
      ...(await router.listDocuments(INDEX, { limit: 12 })).documents.map(
        entry => [entry.id, entry.document] as [string, AnyDocument],
      ),
    ]
    expect(documents).toHaveLength(37)
    for (const [id, document] of documents) {
      expect(document?.title, id).toBe(`lantern book ${indexOf(id)}`)
      expect(document?.embedding, id).toBeUndefined()
      expect((document?.meta as Record<string, unknown> | undefined)?.sketch, id).toBeUndefined()
    }
  }, 30_000)

  it('returns only the nested vector field that an include path names', async () => {
    const projection = { include: ['meta.sketch'] }
    const documents = [
      ...(await router.query(INDEX, { term: 'lantern', limit: 12, document: projection })).hits.map(
        hit => [hit.id, hit.document] as [string, AnyDocument],
      ),
      ...(await router.getMultiple(INDEX, everyId, { document: projection })),
      ...(await router.listDocuments(INDEX, { limit: 12, document: projection })).documents.map(
        entry => [entry.id, entry.document] as [string, AnyDocument],
      ),
    ]
    expect(documents).toHaveLength(36)
    for (const [id, document] of documents) {
      expect(Object.keys(document), id).toEqual(['meta'])
      const sketch = (document.meta as Record<string, unknown>).sketch
      expect(sketch, id).toBeInstanceOf(Float32Array)
      expect(Array.from(sketch as Float32Array), id).toEqual(embeddingOf(indexOf(id) + 1))
    }
  }, 30_000)

  it('returns the vectors of an index that sets returnVectors unless the read turns them off', async () => {
    const KEPT = 'kept-shelves'
    await router.createIndex(
      KEPT,
      { schema: { title: 'string', embedding: 'vector[3]', meta: { sketch: 'vector[3]' } }, returnVectors: true },
      { partitionCount: 4, replicationFactor: 1 },
    )
    for (const nodeId of DATA_NODES) await waitForSettledReplica(coordinator, KEPT, nodeId)
    const inserted = await router.insertBatch(
      KEPT,
      everyId.map(id => ({
        id,
        title: `lantern book ${indexOf(id)}`,
        embedding: embeddingOf(indexOf(id)),
        meta: { sketch: embeddingOf(indexOf(id) + 1) },
      })),
    )
    expect(inserted.failed).toEqual([])

    const searched = await router.query(KEPT, { term: 'lantern', limit: 12 })
    expect(searched.hits).toHaveLength(12)
    for (const hit of searched.hits) expectStoredVectors(hit.document, indexOf(hit.id))
    for (const [id, document] of await router.getMultiple(KEPT, everyId)) expectStoredVectors(document, indexOf(id))
    for (const entry of (await router.listDocuments(KEPT, { limit: 12 })).documents) {
      expectStoredVectors(entry.document, indexOf(entry.id))
    }

    const off = { vectors: false }
    const documents: Array<[string, AnyDocument | undefined]> = [
      ...(await router.query(KEPT, { term: 'lantern', limit: 12, document: off })).hits.map(
        hit => [hit.id, hit.document] as [string, AnyDocument],
      ),
      ...(await router.getMultiple(KEPT, everyId, { document: off })),
      ...(await router.listDocuments(KEPT, { limit: 12, document: off })).documents.map(
        entry => [entry.id, entry.document] as [string, AnyDocument],
      ),
    ]
    expect(documents).toHaveLength(36)
    for (const [id, document] of documents) {
      expect(document?.title, id).toBe(`lantern book ${indexOf(id)}`)
      expect(document?.embedding, id).toBeUndefined()
      expect((document?.meta as Record<string, unknown> | undefined)?.sketch, id).toBeUndefined()
    }
  }, 30_000)
})
