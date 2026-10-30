import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import { localParamsToWire } from '../../../distribution/cluster-node/query-conversion'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport, type InMemoryNetwork } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import { isNarsilError } from '../../../errors'
import { waitForSettledReplica } from './cluster-harness'
import { type FetchRecord, tapTransport, type WireTap } from './search-context-wire'

const INDEX = 'catalogue'
const DATA_NODES = ['data-a', 'data-b']
const RELEASE_WAIT_MS = 5_000

type Item = {
  id: string
  title: string
  rank: number
  note: string
}

function items(total: number): Item[] {
  return Array.from({ length: total }, (_, rank) => ({
    id: `item-${rank}`,
    title: `widget ${rank}`,
    rank,
    note: `original ${rank}`,
  }))
}

function fieldsOf(document: unknown): Omit<Item, 'id'> {
  const record = document as Record<string, unknown>
  return { title: record.title as string, rank: record.rank as number, note: record.note as string }
}

async function waitUntil(label: string, check: () => boolean): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > RELEASE_WAIT_MS) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function releasedContexts(fetches: FetchRecord[]): Set<string> {
  const released = new Set<string>()
  for (const fetch of fetches) {
    if (fetch.contextId !== null && fetch.releaseContext !== false) released.add(fetch.contextId)
  }
  return released
}

describe('a cluster search that reads its hits from the nodes that ranked them', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transports: NodeTransport[]
  let nodes: ClusterNode[]
  let router: ClusterNode
  let tap: WireTap
  let dataTap: WireTap | null

  async function startCluster(
    total: number,
    allowPartialResults = true,
    coordinatingDataNode = false,
  ): Promise<Item[]> {
    for (const nodeId of DATA_NODES) {
      const coordinates = coordinatingDataNode && nodeId === DATA_NODES[0]
      const transport = coordinates ? tapTransport(nodeId, network) : null
      if (transport !== null) dataTap = transport
      const nodeTransport = transport?.transport ?? createInMemoryTransport(nodeId, network)
      transports.push(nodeTransport)
      const node = await createClusterNode({
        coordinator,
        transport: nodeTransport,
        address: `${nodeId}:9200`,
        nodeId,
        roles: coordinates ? ['data', 'coordinator'] : ['data'],
        engine: { workers: { enabled: false } },
      })
      await node.start()
      nodes.push(node)
    }
    tap = tapTransport('router', network)
    transports.push(tap.transport)
    router = await createClusterNode({
      coordinator,
      transport: tap.transport,
      address: 'router:9200',
      nodeId: 'router',
      roles: ['coordinator', 'controller'],
      query: { allowPartialResults },
    })
    await router.start()
    nodes.push(router)
    await router.createIndex(
      INDEX,
      { schema: { title: 'string', rank: 'number', note: 'string' } },
      { partitionCount: 4, replicationFactor: 1 },
    )
    for (const nodeId of DATA_NODES) await waitForSettledReplica(coordinator, INDEX, nodeId)
    const stored = items(total)
    const inserted = await router.insertBatch(INDEX, stored)
    expect(inserted.failed).toEqual([])
    return stored
  }

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transports = []
    nodes = []
    dataTap = null
  })

  afterEach(async () => {
    for (const node of nodes.reverse()) await node.shutdown()
    for (const transport of transports) await transport.shutdown()
    await coordinator.shutdown()
  })

  it('returns a hit that a write removes or changes between ranking and fetch as its node ranked it', async () => {
    const stored = await startCluster(40)
    tap.betweenPhases = async round => {
      if (round !== 1) return
      await router.remove(INDEX, 'item-0')
      await router.update(INDEX, 'item-1', { title: 'widget 1', rank: 1, note: 'rewritten' })
    }

    const result = await router.query(INDEX, { term: 'widget', sort: { rank: 'asc' }, limit: 10 })

    const expected = stored.slice(0, 10)
    expect(result.hits.map(hit => hit.id)).toEqual(expected.map(item => item.id))
    for (const [position, hit] of result.hits.entries()) {
      const { id: _id, ...fields } = expected[position]
      expect(fieldsOf(hit.document)).toEqual(fields)
    }
    expect(tap.rounds()).toBe(1)
    expect(new Set(tap.searches.map(search => search.target))).toEqual(new Set(DATA_NODES))

    const opened = new Set(tap.searches.flatMap(search => (search.contextId === null ? [] : [search.contextId])))
    expect(opened.size).toBe(DATA_NODES.length)
    await waitUntil('every context to be released', () => releasedContexts(tap.fetches).size === opened.size)
    expect(releasedContexts(tap.fetches)).toEqual(opened)

    tap.betweenPhases = null
    const after = await router.query(INDEX, { term: 'widget', sort: { rank: 'asc' }, limit: 2 })
    expect(after.hits.map(hit => hit.id)).toEqual(['item-1', 'item-2'])
    expect(fieldsOf(after.hits[0].document).note).toBe('rewritten')
  }, 30_000)

  it('reads the hits that a coordinating data node ranked itself from its own context', async () => {
    const stored = await startCluster(40, true, true)
    const coordinating = nodes[0]
    const own = dataTap
    if (own === null) throw new Error('the coordinating data node has no tap')
    const removed: string[] = []
    own.afterSearch = async record => {
      if (record.round !== 1 || record.target !== DATA_NODES[0]) return
      for (const id of record.rankedIds) {
        await coordinating.remove(INDEX, id)
        removed.push(id)
      }
    }

    const result = await coordinating.query(INDEX, { term: 'widget', sort: { rank: 'asc' }, limit: 10 })

    expect(removed.length).toBeGreaterThan(0)
    expect(result.hits.map(hit => hit.id)).toEqual(stored.slice(0, 10).map(item => item.id))
    for (const [position, hit] of result.hits.entries()) {
      const { id: _id, ...fields } = stored[position]
      expect(fieldsOf(hit.document)).toEqual(fields)
    }
    expect(own.fetches.filter(fetch => fetch.target === DATA_NODES[0] && fetch.contextId !== null)).toEqual([])
    own.afterSearch = null
    const after = await coordinating.query(INDEX, { term: 'widget', sort: { rank: 'asc' }, limit: 40 })
    for (const id of removed) expect(after.hits.map(hit => hit.id)).not.toContain(id)
  }, 30_000)

  it('reads more than 256 hits from one node in groups, each sent after the last answered', async () => {
    const stored = await startCluster(600)
    const removed = stored.slice(590).map(item => item.id)
    let removedAfter: FetchRecord | null = null
    tap.afterFetch = async record => {
      if (removedAfter !== null || record.contextId === null || record.releaseContext !== false) return
      removedAfter = record
      for (const id of removed) {
        expect(record.docIds).not.toContain(id)
        await router.remove(INDEX, id)
      }
    }

    const result = await router.query(INDEX, { term: 'widget', sort: { rank: 'asc' }, limit: 600 })

    expect(removedAfter).not.toBeNull()
    expect(result.hits.map(hit => hit.id)).toEqual(stored.map(item => item.id))
    for (const [position, hit] of result.hits.entries()) {
      const { id: _id, ...fields } = stored[position]
      expect(fieldsOf(hit.document)).toEqual(fields)
    }
    let chunkedNodes = 0
    for (const nodeId of DATA_NODES) {
      const reads = tap.fetches.filter(fetch => fetch.target === nodeId && fetch.docIds.length > 0)
      const ranked = reads.reduce((sum, fetch) => sum + fetch.docIds.length, 0)
      expect(reads.length).toBe(Math.ceil(ranked / 256))
      if (reads.length > 1) chunkedNodes += 1
      for (const [position, fetch] of reads.entries()) {
        expect(fetch.docIds.length).toBeLessThanOrEqual(256)
        expect(fetch.releaseContext).toBe(position === reads.length - 1)
        const before = reads[position - 1]
        if (before !== undefined) expect(fetch.sentAt).toBeGreaterThan(before.answeredAt ?? Number.POSITIVE_INFINITY)
      }
    }
    expect(chunkedNodes).toBeGreaterThan(0)
    const after = await router.query(INDEX, { term: 'widget', sort: { rank: 'desc' }, limit: 1 })
    expect(after.hits.map(hit => hit.id)).toEqual(['item-589'])
  }, 60_000)

  it('releases the contexts of a search that fails, without reading them', async () => {
    await startCluster(40, false)
    tap.rewriteSearch = payload => {
      if (Array.isArray(payload.partitionIds) && payload.partitionIds.includes(0)) payload.indexName = 'missing'
    }

    const outcome = await router.query(INDEX, { term: 'widget', sort: { rank: 'asc' }, limit: 10 }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(isNarsilError(outcome) && outcome.code).toBe('QUERY_PARTIAL_FAILURE')
    const opened = new Set(tap.searches.flatMap(search => (search.contextId === null ? [] : [search.contextId])))
    expect(opened.size).toBeGreaterThan(0)
    await waitUntil('every context to be released', () => releasedContexts(tap.fetches).size === opened.size)
    for (const fetch of tap.fetches) expect(fetch.docIds).toEqual([])
  }, 30_000)

  it('reads the current documents where the coordinator or the data node predates search contexts', async () => {
    const stored = await startCluster(40)
    tap.betweenPhases = null
    tap.rewriteSearchResult = answer => {
      delete answer.contextId
    }
    const fromOldDataNodes = await router.query(INDEX, { term: 'widget', sort: { rank: 'asc' }, limit: 5 })
    expect(fromOldDataNodes.hits.map(hit => hit.id)).toEqual(stored.slice(0, 5).map(item => item.id))
    expect(tap.fetches.every(fetch => fetch.contextId === null)).toBe(true)

    tap.rewriteSearchResult = null
    tap.rewriteSearch = payload => {
      delete payload.keepAliveMs
    }
    await router.remove(INDEX, 'item-0')
    const fromOldCoordinator = await router.query(INDEX, { term: 'widget', sort: { rank: 'asc' }, limit: 5 })
    expect(fromOldCoordinator.hits.map(hit => hit.id)).toEqual(stored.slice(1, 6).map(item => item.id))
    const rounds = tap.searches.filter(search => search.keepAliveMs === null)
    expect(rounds.length).toBeGreaterThan(0)
    expect(rounds.every(search => search.contextId === null)).toBe(true)
  }, 30_000)

  it('frees the contexts of a coordinating node once it leaves the cluster', async () => {
    await startCluster(40)
    const probe = createInMemoryTransport('probe', network)
    transports.push(probe)
    const departing = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport('departing', network),
      address: 'departing:9200',
      nodeId: 'departing',
      roles: ['coordinator'],
    })
    await departing.start()
    const allocation = await coordinator.getAllocation(INDEX)
    const partitionIds = [...(allocation?.assignments.entries() ?? [])]
      .filter(([, assignment]) => assignment.primary === 'data-a')
      .map(([partitionId]) => partitionId)
    expect(partitionIds.length).toBeGreaterThan(0)

    const search = await probe.send('data-a', {
      type: 'query.search',
      sourceId: 'departing',
      requestId: 'probe-search',
      payload: encode({
        indexName: INDEX,
        partitionIds,
        params: localParamsToWire({ term: 'widget', limit: 5 }),
        globalStats: null,
        facetShardSize: null,
        keepAliveMs: 60_000,
      }),
    })
    const contextId = (decode(search.payload) as { contextId?: string }).contextId
    expect(typeof contextId).toBe('string')
    const fetchContext = async () =>
      decode(
        (
          await probe.send('data-a', {
            type: 'query.fetch',
            sourceId: 'probe',
            requestId: `probe-fetch-${Date.now()}`,
            payload: encode({
              indexName: INDEX,
              documentIds: [{ docId: 'item-0', partitionId: 0 }],
              fields: null,
              highlight: null,
              contextId,
              releaseContext: false,
            }),
          })
        ).payload,
      ) as { documents?: unknown[]; code?: string }

    expect((await fetchContext()).code).toBeUndefined()
    await departing.shutdown()
    let answer = await fetchContext()
    const start = Date.now()
    while (answer.code === undefined && Date.now() - start < RELEASE_WAIT_MS) {
      await new Promise(resolve => setTimeout(resolve, 20))
      answer = await fetchContext()
    }
    expect(answer.code).toBe('SEARCH_CONTEXT_MISSING')
  }, 30_000)

  function refuseForMemory(answer: Record<string, unknown>): void {
    for (const key of Object.keys(answer)) delete answer[key]
    Object.assign(answer, {
      error: true,
      code: 'TOO_MANY_REQUESTS',
      message: 'Holding the ranked documents would fill this node',
      details: { reason: 'response_would_fill_memory' },
    })
  }

  it('answers from the other copy when one node refuses its part of the search for memory', async () => {
    await startCluster(40)
    tap.rewriteSearchResult = (answer, target) => {
      if (target === DATA_NODES[0]) refuseForMemory(answer)
    }

    const result = await router.query(INDEX, { term: 'widget', sort: { rank: 'asc' }, limit: 40 })

    expect(result.count).toBe(40)
    expect(result.hits.map(hit => hit.id)).toEqual(items(40).map(item => item.id))
  })

  it('refuses the whole search with TOO_MANY_REQUESTS when every copy refuses for memory, even with partial results allowed', async () => {
    await startCluster(40)
    tap.rewriteSearchResult = answer => refuseForMemory(answer)

    const outcome = await router.query(INDEX, { term: 'widget', limit: 40 }).then(
      result => result,
      (error: unknown) => error,
    )

    if (!isNarsilError(outcome)) throw new Error(`the search answered ${JSON.stringify(outcome).slice(0, 200)}`)
    expect(outcome.code).toBe('TOO_MANY_REQUESTS')
    expect(outcome.details.reason).toBe('response_would_fill_memory')
  })
})
