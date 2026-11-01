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
import { cosineOf, oracleRrf, type RankedHit } from '../../rerank/oracle'
import { waitForSettledReplica } from './cluster-harness'

interface SearchPayload {
  params: Record<string, unknown>
}

const INDEX = 'library'
const DATA_NODES = ['data-a', 'data-b']
const TERM = 'river stone cedar'
const VECTOR_TEXT = 'harbor'

const EARLIER_RELEASE_MEMBERS = [
  'term',
  'filters',
  'sort',
  'group',
  'facets',
  'facetSize',
  'limit',
  'offset',
  'searchAfter',
  'fields',
  'boost',
  'tolerance',
  'threshold',
  'includeScores',
  'scoring',
  'termMatch',
  'prefixLength',
  'prefix',
  'partialWords',
  'exact',
  'pinned',
  'mode',
  'vector',
  'hybrid',
]

const MEMBERS_THE_EARLIER_RELEASE_IGNORES = ['bm25', 'indexBm25', 'analysisGeneration']

function earlierReleaseRefusal(payload: SearchPayload): string | null {
  const params = payload.params as unknown as Record<string, unknown>
  const unknown = Object.keys(params).filter(
    key => !EARLIER_RELEASE_MEMBERS.includes(key) && !MEMBERS_THE_EARLIER_RELEASE_IGNORES.includes(key),
  )
  if (unknown.length > 0) return `unknown members ${unknown.join(', ')}`
  const missing = EARLIER_RELEASE_MEMBERS.filter(key => !Object.hasOwn(params, key))
  if (missing.length > 0) return `missing members ${missing.join(', ')}`
  const hybrid = params.hybrid
  if (hybrid === null) return null
  const keys = Object.keys(hybrid as Record<string, unknown>).sort()
  return keys.join(',') === 'alpha,k,strategy' ? null : `hybrid members ${keys.join(', ')}`
}

function earlierReleaseTransport(
  nodeId: string,
  network: InMemoryNetwork,
  served: SearchPayload[],
  refusals: string[],
): NodeTransport {
  const transport = createInMemoryTransport(nodeId, network)
  return {
    ...transport,
    listen(handler) {
      return transport.listen((message, respond) => {
        if (message.type === 'query.search') {
          const payload = decode(message.payload) as SearchPayload
          served.push(payload)
          const refusal = earlierReleaseRefusal(payload)
          if (refusal !== null) {
            refusals.push(refusal)
            throw new Error(`an earlier release refuses this payload: ${refusal}`)
          }
        }
        return handler(message, respond)
      })
    },
  }
}

describe('hybrid paging to a fixed depth on a cluster', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transports: NodeTransport[]
  let nodes: ClusterNode[]
  let router: ClusterNode
  let served: SearchPayload[]
  let refusals: string[]
  let documents: CorpusDocument[]

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transports = []
    nodes = []
    served = []
    refusals = []
    for (const nodeId of DATA_NODES) {
      const transport = earlierReleaseTransport(nodeId, network, served, refusals)
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

  const vector = { field: 'embedding', value: Array.from(letterEmbedding(VECTOR_TEXT)) }

  function hybridQuery(depth: number): QueryParams {
    return { term: TERM, termMatch: 'any', vector, hybrid: { depth } }
  }

  async function oracleFused(depth: number): Promise<RankedHit[]> {
    const text = await router.query(INDEX, { term: TERM, termMatch: 'any', limit: depth })
    const vectors = await router.query(INDEX, { vector, limit: depth })
    const query = letterEmbedding(VECTOR_TEXT)
    const byId = new Map(documents.map(document => [document.id, document]))
    const cosines = documents
      .map(document => cosineOf(letterEmbedding(document.title), query))
      .sort((a, b) => b - a)
      .slice(0, depth)
    for (const [i, hit] of vectors.hits.entries()) {
      const document = byId.get(hit.id) as CorpusDocument
      expect(hit.score).toBeCloseTo(cosineOf(letterEmbedding(document.title), query), 5)
      expect(hit.score).toBeCloseTo(cosines[i], 5)
    }
    const ranked = (hits: Array<{ id: string; score?: number }>): RankedHit[] =>
      hits.map(hit => ({ id: hit.id, score: hit.score ?? 0 }))
    return oracleRrf([ranked(text.hits), ranked(vectors.hits)]).slice(0, depth)
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

  it('returns the oracle fused order by cursor and by offset, from data nodes on the earlier release', async () => {
    const expected = await oracleFused(30)
    served.length = 0

    const walked = await walk(hybridQuery(30), 7)
    const byOffset: RankedHit[] = []
    for (let offset = 0; offset < 30; offset += 10) {
      const page = await router.query(INDEX, { ...hybridQuery(30), offset, limit: 10 })
      byOffset.push(...page.hits.map(hit => ({ id: hit.id, score: hit.score ?? 0 })))
    }

    for (const actual of [walked, byOffset]) {
      expect(actual.map(hit => hit.id)).toEqual(expected.map(hit => hit.id))
      for (const [i, hit] of actual.entries()) expect(hit.score).toBeCloseTo(expected[i].score, 9)
    }
    expect(refusals).toEqual([])
    expect(served.length).toBeGreaterThan(0)
    for (const payload of served) {
      expect(payload.params.hybrid).toBeNull()
      expect([payload.params.limit, payload.params.offset, payload.params.searchAfter]).toEqual([30, 0, null])
    }
    const windows = served.flatMap(payload =>
      payload.params.vector === null ? [] : [(payload.params.vector as { rescoreWindow: unknown }).rescoreWindow],
    )
    expect(windows.length).toBeGreaterThan(0)
    expect(new Set(windows).size).toBe(1)
    expect(windows[0]).toEqual(expect.any(Number))
    expect(windows[0]).toBeGreaterThanOrEqual(1)
    expect(windows[0]).toBeLessThan(30)

    served.length = 0
    await router.query(INDEX, { vector, limit: 30 })
    expect(served.length).toBeGreaterThan(0)
    expect(served.map(payload => (payload.params.vector as { rescoreWindow: unknown }).rescoreWindow)).toEqual(
      served.map(() => null),
    )
  }, 30_000)

  it('refuses a cursor written at depth 20 when it comes back at depth 30', async () => {
    const first = await router.query(INDEX, { ...hybridQuery(20), limit: 5 })
    expect(first.cursor).toBeDefined()

    await expect(
      router.query(INDEX, { ...hybridQuery(30), limit: 5, searchAfter: first.cursor }),
    ).rejects.toMatchObject({ code: ErrorCodes.SEARCH_INVALID_CURSOR })
    const second = await router.query(INDEX, { ...hybridQuery(20), limit: 5, searchAfter: first.cursor })
    expect(second.hits).toHaveLength(5)
  }, 30_000)

  it('serves a short last page, and refuses a page that starts at the depth and a depth above 10,000', async () => {
    const expected = await oracleFused(20)
    const last = await router.query(INDEX, { ...hybridQuery(20), offset: 15, limit: 10 })
    expect(last.hits.map(hit => hit.id)).toEqual(expected.slice(15).map(hit => hit.id))
    expect(last.cursor).toBeUndefined()
    await expect(router.query(INDEX, { ...hybridQuery(20), offset: 20, limit: 1 })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_RESULT_WINDOW_EXCEEDED,
      message: expect.stringContaining('hybrid.depth'),
    })
    await expect(router.query(INDEX, hybridQuery(10_001))).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })
  }, 30_000)
})
