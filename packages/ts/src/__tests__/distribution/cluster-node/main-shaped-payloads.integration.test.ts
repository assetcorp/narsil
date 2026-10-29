import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ClusterCoordinator, type ClusterNode, createClusterNode, type NodeTransport } from '../../../distribution'
import { createInMemoryCoordinator } from '../../../distribution/coordinator/in-memory'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport/in-memory'
import { type CorpusDocument, corpus, letterEmbedding, stored } from '../../rerank/corpus'
import { cosineOf, oracleRrf, type RankedHit } from '../../rerank/oracle'
import { waitForSettledReplica } from './cluster-harness'

interface SearchPayload {
  params: { vector: Record<string, unknown> | null; hybrid: Record<string, unknown> | null }
}

const INDEX = 'library'
const DATA_NODES = ['data-a', 'data-b']
const TERM = 'river stone cedar'
const VECTOR_TEXT = 'harbor'

function mainShapedTransport(nodeId: string, network: ReturnType<typeof createInMemoryNetwork>, sent: SearchPayload[]) {
  const transport = createInMemoryTransport(nodeId, network)
  const shaped: NodeTransport = {
    ...transport,
    send(target, message) {
      if (message.type !== 'query.search') return transport.send(target, message)
      const payload = decode(message.payload) as SearchPayload
      if (payload.params.vector !== null) delete payload.params.vector.rescoreWindow
      if (payload.params.hybrid !== null) delete payload.params.hybrid.depth
      sent.push(payload)
      return transport.send(target, { ...message, payload: encode(payload) })
    },
  }
  return shaped
}

describe('a data node on this release serving a coordinator on the release before it', () => {
  let coordinator: ClusterCoordinator
  let transports: NodeTransport[]
  let nodes: ClusterNode[]
  let router: ClusterNode
  let sent: SearchPayload[]
  let documents: CorpusDocument[]

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    const network = createInMemoryNetwork()
    transports = []
    nodes = []
    sent = []
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
    const routerTransport = mainShapedTransport('router', network, sent)
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
      { schema: { title: 'string', tags: 'string[]', summary: 'string', category: 'enum', embedding: 'vector[3]' } },
      { partitionCount: 4, replicationFactor: 1 },
    )
    for (const nodeId of DATA_NODES) await waitForSettledReplica(coordinator, INDEX, nodeId)
    documents = corpus(120, 41)
    const inserted = await router.insertBatch(
      INDEX,
      documents.map(document => ({
        ...stored(document),
        id: document.id,
        embedding: Array.from(letterEmbedding(document.title)),
      })),
    )
    expect(inserted.failed).toEqual([])
  }, 30_000)

  afterEach(async () => {
    for (const node of nodes) await node.shutdown()
    for (const transport of transports) await transport.shutdown()
    await coordinator.shutdown()
  })

  it('answers vector and hybrid queries that omit rescoreWindow and hybrid.depth with the results main gives', async () => {
    const query = letterEmbedding(VECTOR_TEXT)
    const vector = { field: 'embedding', value: Array.from(query) }
    const exact = documents.map(document => cosineOf(letterEmbedding(document.title), query)).sort((a, b) => b - a)
    const byId = new Map(documents.map(document => [document.id, document]))

    const vectorHits = (await router.query(INDEX, { vector, hybrid: { strategy: 'rrf' }, limit: 10 })).hits
    expect(vectorHits).toHaveLength(10)
    for (const [i, hit] of vectorHits.entries()) {
      const document = byId.get(hit.id) as CorpusDocument
      expect(hit.score).toBeCloseTo(cosineOf(letterEmbedding(document.title), query), 5)
      expect(hit.score).toBeCloseTo(exact[i], 5)
    }

    const text = (await router.query(INDEX, { term: TERM, termMatch: 'any', limit: 10 })).hits
    const ranked = (hits: Array<{ id: string; score?: number }>): RankedHit[] =>
      hits.map(hit => ({ id: hit.id, score: hit.score ?? 0 }))
    const expected = oracleRrf([ranked(text), ranked(vectorHits)]).slice(0, 10)
    const fused = (await router.query(INDEX, { term: TERM, termMatch: 'any', vector, limit: 10 })).hits

    expect(fused.map(hit => hit.id)).toEqual(expected.map(hit => hit.id))
    for (const [i, hit] of fused.entries()) expect(hit.score).toBeCloseTo(expected[i].score, 9)
    expect(sent.some(payload => payload.params.hybrid !== null)).toBe(true)
    expect(sent.some(payload => payload.params.vector !== null)).toBe(true)
    for (const payload of sent) {
      expect(payload.params.vector === null || !Object.hasOwn(payload.params.vector, 'rescoreWindow')).toBe(true)
      expect(payload.params.hybrid === null || !Object.hasOwn(payload.params.hybrid, 'depth')).toBe(true)
    }
  }, 30_000)
})
