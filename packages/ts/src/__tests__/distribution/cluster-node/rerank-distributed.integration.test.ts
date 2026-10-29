import { decode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ClusterCoordinator, type ClusterNode, createClusterNode, type NodeTransport } from '../../../distribution'
import { createInMemoryCoordinator } from '../../../distribution/coordinator/in-memory'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'
import { ErrorCodes } from '../../../errors'
import type { QueryParams } from '../../../types/search'
import { type CorpusDocument, corpus, letterEmbedding, stored } from '../../rerank/corpus'
import { oracleRerank, overlapScore, type RankedHit, recordingReranker, rerankTextOf } from '../../rerank/oracle'
import { waitForSettledReplica } from './cluster-harness'

interface SearchPayload {
  params: Record<string, unknown>
}

const INDEX = 'library'
const DATA_NODES = ['data-a', 'data-b']

function recordingTransport(nodeId: string, network: InMemoryNetwork, served: SearchPayload[]): NodeTransport {
  const transport = createInMemoryTransport(nodeId, network)
  return {
    ...transport,
    listen(handler) {
      return transport.listen((message, respond) => {
        if (message.type === 'query.search') served.push(decode(message.payload) as SearchPayload)
        return handler(message, respond)
      })
    },
  }
}

describe('reranking on a cluster coordinator', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transports: NodeTransport[]
  let nodes: ClusterNode[]
  let router: ClusterNode
  let served: SearchPayload[]
  let documents: CorpusDocument[]
  let byId: Map<string, CorpusDocument>

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transports = []
    nodes = []
    served = []
    for (const nodeId of DATA_NODES) {
      const transport = recordingTransport(nodeId, network, served)
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
      { schema: { title: 'string', tags: 'string[]', summary: 'string', category: 'enum', embedding: 'vector[3]' } },
      { partitionCount: 4, replicationFactor: 1 },
    )
    for (const nodeId of DATA_NODES) await waitForSettledReplica(coordinator, INDEX, nodeId)
    documents = corpus(80, 23)
    byId = new Map(documents.map(document => [document.id, document]))
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

  async function firstStage(params: QueryParams): Promise<RankedHit[]> {
    const result = await router.query(INDEX, { ...params, limit: 10_000 })
    return result.hits.map(hit => ({ id: hit.id, score: hit.score ?? 0 }))
  }

  function oracleOrder(first: RankedHit[], window: number, query: string, fields: string[]): RankedHit[] {
    const scores = first
      .slice(0, window)
      .map(hit => overlapScore(query, rerankTextOf(stored(byId.get(hit.id) as CorpusDocument), fields)))
    return oracleRerank(first, window, scores)
  }

  async function walk(params: QueryParams, limit: number): Promise<RankedHit[]> {
    const seen: RankedHit[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const result = await router.query(INDEX, { ...params, limit, searchAfter: cursor })
      seen.push(...result.hits.map(hit => ({ id: hit.id, score: hit.score ?? 0 })))
      cursor = result.cursor
      if (cursor === undefined) return seen
    }
    throw new Error('the cursor never ran out')
  }

  it.each<[string, QueryParams, string]>([
    ['keyword', { term: 'river stone north', termMatch: 'any' }, 'river stone north'],
    ['vector', { vector: { field: 'embedding', value: Array.from(letterEmbedding('cedar glass')) } }, 'cedar glass'],
  ])(
    'reranks a %s query on the coordinator, with the oracle order on every page',
    async (_mode, base, query) => {
      const reranker = recordingReranker()
      router.registerRerankAdapter('overlap', reranker)
      const fields = ['title', 'tags']
      const expected = oracleOrder(await firstStage(base), 10, query, fields)
      served.length = 0

      const walked = await walk({ ...base, rerank: { adapter: 'overlap', fields, query, window: 10 } }, 4)

      expect(walked.map(hit => hit.id)).toEqual(expected.map(hit => hit.id))
      for (const [i, hit] of walked.entries()) expect(hit.score).toBeCloseTo(expected[i].score, 9)
      expect(reranker.calls.length).toBeGreaterThan(0)
      expect(served.length).toBeGreaterThan(0)
      for (const payload of served) {
        expect(Object.keys(payload.params)).not.toContain('rerank')
        expect(payload.params.searchAfter ?? null).toBeNull()
        expect(payload.params.pinned ?? null).toBeNull()
      }
    },
    30_000,
  )

  it('keeps the count and facets of the query without rerank and fetches the page documents', async () => {
    router.registerRerankAdapter('overlap', recordingReranker())
    const base: QueryParams = { term: 'harbor', facets: { category: {} }, limit: 3 }
    const plain = await router.query(INDEX, base)
    const reranked = await router.query(INDEX, { ...base, rerank: { adapter: 'overlap', fields: ['title'] } })
    expect(reranked.count).toBe(plain.count)
    expect(reranked.facets).toEqual(plain.facets)
    const everyDocument = new Map(
      (await router.query(INDEX, { term: 'harbor', limit: 10_000 })).hits.map(hit => [hit.id, hit.document]),
    )
    expect(reranked.hits.length).toBe(3)
    for (const hit of reranked.hits) {
      expect(hit.document).toMatchObject(stored(byId.get(hit.id) as CorpusDocument))
      expect(hit.document).toEqual(everyDocument.get(hit.id))
    }
  }, 30_000)

  it('places a pinned document and continues after the last organic hit', async () => {
    router.registerRerankAdapter('overlap', recordingReranker())
    const base: QueryParams = { term: 'lantern' }
    const rerank = { adapter: 'overlap', fields: ['title'], window: 8 }
    const expected = oracleOrder(await firstStage(base), 8, 'lantern', ['title'])
    const outside = documents.find(document => !expected.some(hit => hit.id === document.id))
    expect(outside).toBeDefined()
    const pinned = [{ docId: (outside as CorpusDocument).id, position: 2 }]

    const first = await router.query(INDEX, { ...base, rerank, pinned, limit: 4 })
    const plain = await router.query(INDEX, { ...base, pinned, limit: 4 })
    expect([first.count, first.countExact]).toEqual([plain.count, plain.countExact])
    const withPin = expected.map(hit => hit.id)
    withPin.splice(2, 0, pinned[0].docId)
    expect(first.hits.map(hit => hit.id)).toEqual(withPin.slice(0, 4))

    const second = await router.query(INDEX, { ...base, rerank, pinned, limit: 4, searchAfter: first.cursor })
    expect(second.hits.map(hit => hit.id)).toEqual(expected.slice(3, 7).map(hit => hit.id))
    expect(second.count).toBe(expected.length)
  }, 30_000)

  it('raises typed errors for a missing adapter and a failing one', async () => {
    const rerank = { adapter: 'model', fields: ['title'] }
    await expect(router.query(INDEX, { term: 'river', rerank })).rejects.toMatchObject({
      code: ErrorCodes.RERANK_CONFIG_INVALID,
    })
    router.registerRerankAdapter('model', {
      async rerank() {
        throw new Error('model offline')
      },
    })
    await expect(router.query(INDEX, { term: 'river', rerank })).rejects.toMatchObject({
      code: ErrorCodes.RERANK_FAILED,
    })
  }, 30_000)
})
