import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport, type InMemoryNetwork } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import { isNarsilError } from '../../../errors'
import { waitForSettledReplica } from './cluster-harness'
import { tapTransport, type WireTap } from './search-context-wire'

const INDEX = 'catalogue'
const DATA_NODES = ['data-a', 'data-b']
const DOCUMENT_TOTAL = 40
const LIMIT = 10
const EXPIRED_KEEP_ALIVE_MS = 1
const PAST_KEEP_ALIVE_MS = 30

const expectedIds = Array.from({ length: LIMIT }, (_, rank) => `item-${rank}`)
const sortedQuery = { term: 'widget', sort: { rank: 'asc' as const }, limit: LIMIT }

describe('a cluster search whose ranking node loses its search context before the fetch', () => {
  let directory: string
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transports: NodeTransport[]
  let dataNodes: Map<string, ClusterNode>
  let dataTransports: Map<string, NodeTransport>
  let router: ClusterNode
  let tap: WireTap

  async function startDataNode(nodeId: string): Promise<ClusterNode> {
    const transport = createInMemoryTransport(nodeId, network)
    transports.push(transport)
    dataTransports.set(nodeId, transport)
    const node = await createClusterNode({
      coordinator,
      transport,
      address: `${nodeId}:9200`,
      nodeId,
      roles: ['data'],
      engine: { workers: { enabled: false }, durability: { directory: join(directory, nodeId) } },
    })
    await node.start()
    dataNodes.set(nodeId, node)
    return node
  }

  async function restartDataNode(nodeId: string): Promise<void> {
    await dataNodes.get(nodeId)?.shutdown()
    await dataTransports.get(nodeId)?.shutdown()
    dataNodes.delete(nodeId)
    await startDataNode(nodeId)
  }

  async function startCluster(replicationFactor: number): Promise<void> {
    for (const nodeId of DATA_NODES) await startDataNode(nodeId)
    tap = tapTransport('router', network)
    transports.push(tap.transport)
    router = await createClusterNode({
      coordinator,
      transport: tap.transport,
      address: 'router:9200',
      nodeId: 'router',
      roles: ['coordinator', 'controller'],
    })
    await router.start()
    await router.createIndex(
      INDEX,
      { schema: { title: 'string', rank: 'number', note: 'string' } },
      { partitionCount: 4, replicationFactor },
    )
    for (const nodeId of DATA_NODES) await waitForSettledReplica(coordinator, INDEX, nodeId)
    const inserted = await router.insertBatch(
      INDEX,
      Array.from({ length: DOCUMENT_TOTAL }, (_, rank) => ({
        id: `item-${rank}`,
        title: `widget ${rank}`,
        rank,
        note: `original ${rank}`,
      })),
    )
    expect(inserted.failed).toEqual([])
  }

  async function failureOf(run: Promise<unknown>): Promise<unknown> {
    return run.then(
      () => null,
      (error: unknown) => error,
    )
  }

  function contextReadErrors(round: number): Array<string | null> {
    return tap.fetches.filter(fetch => fetch.round === round && fetch.docIds.length > 0).map(fetch => fetch.errorCode)
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-search-context-loss-'))
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transports = []
    dataNodes = new Map()
    dataTransports = new Map()
  })

  afterEach(async () => {
    await router.shutdown()
    for (const node of dataNodes.values()) await node.shutdown()
    for (const transport of transports) await transport.shutdown()
    await coordinator.shutdown()
    await rm(directory, { recursive: true, force: true })
  })

  it('reruns a search once when a context expires, and answers from the rerun', async () => {
    await startCluster(1)
    tap.rewriteSearch = (payload, round) => {
      if (round === 1) payload.keepAliveMs = EXPIRED_KEEP_ALIVE_MS
    }
    tap.betweenPhases = async round => {
      if (round === 1) await new Promise(resolve => setTimeout(resolve, PAST_KEEP_ALIVE_MS))
    }

    const result = await router.query(INDEX, sortedQuery)

    expect(result.hits.map(hit => hit.id)).toEqual(expectedIds)
    expect(tap.rounds()).toBe(2)
    expect(contextReadErrors(1)).toContain('SEARCH_CONTEXT_MISSING')
    expect(contextReadErrors(2).every(code => code === null)).toBe(true)
  }, 30_000)

  it('raises SEARCH_CONTEXT_MISSING when the context expires in the rerun as well', async () => {
    await startCluster(1)
    tap.rewriteSearch = payload => {
      payload.keepAliveMs = EXPIRED_KEEP_ALIVE_MS
    }
    tap.betweenPhases = () => new Promise(resolve => setTimeout(resolve, PAST_KEEP_ALIVE_MS))

    const failure = await failureOf(router.query(INDEX, sortedQuery))

    expect(isNarsilError(failure) && failure.code).toBe('SEARCH_CONTEXT_MISSING')
    expect(tap.rounds()).toBe(2)
  }, 30_000)

  it('reruns a search once when a ranking node restarts before the fetch', async () => {
    await startCluster(1)
    tap.betweenPhases = async round => {
      if (round === 1) await restartDataNode('data-b')
    }

    const result = await router.query(INDEX, sortedQuery)

    expect(result.hits.map(hit => hit.id)).toEqual(expectedIds)
    expect(result.coverage?.queriedPartitions).toBe(4)
    expect(tap.rounds()).toBe(2)
    expect(tap.searches.some(search => search.round === 1 && search.target === 'data-b')).toBe(true)
  }, 60_000)

  it('raises SEARCH_CONTEXT_MISSING when a ranking node restarts before the fetch of the rerun too', async () => {
    await startCluster(1)
    tap.betweenPhases = () => restartDataNode('data-b')

    const failure = await failureOf(router.query(INDEX, sortedQuery))

    expect(isNarsilError(failure) && failure.code).toBe('SEARCH_CONTEXT_MISSING')
    expect(tap.rounds()).toBe(2)
  }, 60_000)

  it('reruns a search on the other copy when a ranking node is lost before the fetch', async () => {
    await startCluster(2)
    let lost: string | null = null
    tap.betweenPhases = async (round, contexts) => {
      if (round !== 1) return
      lost = contexts[0]?.target ?? null
      if (lost === null) return
      await dataNodes.get(lost)?.shutdown()
      await dataTransports.get(lost)?.shutdown()
      dataNodes.delete(lost)
    }

    const result = await router.query(INDEX, sortedQuery)

    expect(lost).not.toBeNull()
    expect(result.hits.map(hit => hit.id)).toEqual(expectedIds)
    expect(tap.rounds()).toBe(2)
    expect(
      tap.searches.filter(search => search.round === 2 && search.contextId !== null).map(s => s.target),
    ).not.toContain(lost)
  }, 60_000)

  it('raises SEARCH_CONTEXT_MISSING when the ranking nodes of the rerun cannot be reached either', async () => {
    await startCluster(1)
    tap.unreachable = () => true

    const failure = await failureOf(router.query(INDEX, sortedQuery))

    expect(isNarsilError(failure) && failure.code).toBe('SEARCH_CONTEXT_MISSING')
    expect(tap.rounds()).toBe(2)
  }, 30_000)
})
