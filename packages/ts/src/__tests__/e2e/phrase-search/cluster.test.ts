import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { ErrorCodes } from '../../../errors'
import type { QueryParams } from '../../../types/search'
import { type GarageCluster, startGarageCluster } from '../synonyms/cluster-harness'
import { INDEX, LANGUAGE_NAME, pantryCorpus, registerPantryLanguage, SCHEMA } from './corpus'
import { expectEveryProbe, hitsOf, RESULT_LIMIT, type SearchFn } from './harness'
import { createOracle } from './oracle'

vi.setConfig({ testTimeout: 120_000 })

const PARTITIONS = 6
const POLL_BUDGET_MS = 20_000
const clusters: GarageCluster[] = []

beforeAll(() => {
  registerPantryLanguage()
})

afterEach(async () => {
  for (const cluster of clusters.splice(0)) await cluster.shutdown()
})

async function waitForCopies(coordinator: ClusterCoordinator, replicas: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    const table = await coordinator.getAllocation(INDEX)
    const ready =
      table !== null &&
      table.assignments.size > 0 &&
      [...table.assignments.values()].every(
        entry =>
          entry.state === 'ACTIVE' &&
          entry.primary !== null &&
          entry.replicas.length === replicas &&
          entry.replicas.every(replica => entry.inSyncSet.includes(replica)),
      )
    if (ready) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the allocation never settled')
}

async function pantryCluster(replicationFactor: number, documentCount = 400) {
  const cluster = await startGarageCluster(['node-a', 'node-b', 'node-c'])
  clusters.push(cluster)
  const node = cluster.node('node-a')
  await node.createIndex(
    INDEX,
    { schema: SCHEMA, language: LANGUAGE_NAME },
    { partitionCount: PARTITIONS, replicationFactor },
  )
  await waitForCopies(cluster.watched.coordinator, replicationFactor)
  const documents = pantryCorpus(documentCount, 99)
  expect((await node.insertBatch(INDEX, documents)).failed).toEqual([])
  return { cluster, node, documents }
}

async function registerVersion(cluster: GarageCluster, nodeId: string, version: string): Promise<void> {
  const coordinator = cluster.watched.coordinator
  const registration = (await coordinator.listNodes()).find(node => node.nodeId === nodeId)
  if (registration === undefined) throw new Error(`no registration for ${nodeId}`)
  await coordinator.registerNode({ ...registration, version })
}

describe('phrase search across a cluster', () => {
  it('matches the independent oracle under DFS, from whichever node coordinates', async () => {
    const { cluster, documents } = await pantryCluster(0)
    for (const nodeId of ['node-a', 'node-b']) {
      const node = cluster.node(nodeId)
      const search: SearchFn = async query =>
        hitsOf(await node.query(INDEX, { ...query, scoring: 'dfs', limit: RESULT_LIMIT } as QueryParams))
      expect(await expectEveryProbe(search, documents, nodeId)).toBeGreaterThan(500)
    }
    const expected = createOracle(documents).search({ term: '"olive oil"' }).length
    expect((await cluster.node('node-c').preflight(INDEX, { term: '"olive oil"' })).count).toBe(expected)
  })

  it('fails the whole query where a data node refuses, whatever partial results allow', async () => {
    const { node } = await pantryCluster(0, 40)
    const term = `"${Array.from({ length: 33 }, () => 'olive').join(' ')}"`
    await expect(node.query(INDEX, { term })).rejects.toMatchObject({ code: ErrorCodes.SEARCH_INVALID_PHRASE })
    await expect(node.preflight(INDEX, { term })).rejects.toMatchObject({ code: ErrorCodes.SEARCH_INVALID_PHRASE })
  })

  it('refuses a phrase while a registered node that stores the index runs an older version', async () => {
    const { cluster, node, documents } = await pantryCluster(1, 60)
    await registerVersion(cluster, 'node-b', '1.0')
    await expect(node.query(INDEX, { term: '"olive oil"' })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_PHRASE_NOT_READY,
    })
    await expect(node.preflight(INDEX, { term: '"olive oil"' })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_PHRASE_NOT_READY,
    })
    const asVectorMode: QueryParams = {
      mode: 'vector',
      term: '"olive oil"',
      vector: { field: 'absent', value: [1, 0] },
    }
    await expect(node.query(INDEX, asVectorMode)).rejects.toMatchObject({ code: ErrorCodes.SEARCH_PHRASE_NOT_READY })
    const plain = createOracle(documents).search({ term: 'olive' }).length
    expect((await node.query(INDEX, { term: 'olive', limit: RESULT_LIMIT })).hits.length).toBe(plain)
    expect((await node.query(INDEX, { term: '"" olive', limit: RESULT_LIMIT })).hits.length).toBe(plain)
  })

  it('reads a version as whole numbers, so 1.10 reaches 1.1 and 1.9 does too', async () => {
    const { cluster, node } = await pantryCluster(0, 30)
    for (const version of ['1.10', '1.9', '2.0']) {
      await registerVersion(cluster, 'node-b', version)
      await expect(node.query(INDEX, { term: '"olive oil"' })).resolves.toBeDefined()
    }
    for (const version of ['1.0', '0.9', 'one.one', '1']) {
      await registerVersion(cluster, 'node-b', version)
      await expect(node.query(INDEX, { term: '"olive oil"' })).rejects.toMatchObject({
        code: ErrorCodes.SEARCH_PHRASE_NOT_READY,
      })
    }
  })

  it('never asks a copy whose node has no registration, though the node still answers messages', async () => {
    const { cluster, node, documents } = await pantryCluster(1)
    await cluster.watched.coordinator.deregisterNode('node-c')
    cluster.exchanges.length = 0

    const term = '"olive oil"'
    const expected = createOracle(documents)
      .search({ term })
      .map(hit => hit.id)
      .sort()
    for (let round = 0; round < 6; round++) {
      const answer = await node.query(INDEX, { term: `${term}${' '.repeat(round)}`, limit: RESULT_LIMIT })
      expect(answer.coverage?.queriedPartitions).toBeLessThanOrEqual(PARTITIONS)
      const partial = answer.hits.map(hit => hit.id).sort()
      for (const id of partial) expect(expected).toContain(id)
    }
    const searched = cluster.exchanges.filter(
      exchange => exchange.request.type === 'query.search' && exchange.target.startsWith('node-c'),
    )
    expect(searched).toEqual([])
  })

  it('answers from the other copy when one node lost its registration and its partitions keep a replica', async () => {
    const { cluster, node, documents } = await pantryCluster(1)
    const table = await cluster.watched.coordinator.getAllocation(INDEX)
    const held = [...(table?.assignments.values() ?? [])]
    const everyPartitionKeepsACopy = held.every(entry =>
      [entry.primary, ...entry.replicas].some(holder => holder !== null && holder !== 'node-c'),
    )
    expect(everyPartitionKeepsACopy).toBe(true)
    await cluster.watched.coordinator.deregisterNode('node-c')

    const term = '"olive oil"'
    const expected = createOracle(documents)
      .search({ term })
      .map(hit => hit.id)
      .sort()
    const answer = await node.query(INDEX, { term, limit: RESULT_LIMIT })
    expect(answer.hits.map(hit => hit.id).sort()).toEqual(expected)
    expect(answer.coverage?.failedPartitions).toBe(0)
  })

  it('counts a partition with every copy unregistered as unavailable', async () => {
    const { cluster, node, documents } = await pantryCluster(0)
    await cluster.watched.coordinator.deregisterNode('node-c')
    const term = '"olive oil"'
    const expected = new Set(
      createOracle(documents)
        .search({ term })
        .map(hit => hit.id),
    )
    const answer = await node.query(INDEX, { term, limit: RESULT_LIMIT })
    expect(answer.hits.length).toBeLessThan(expected.size)
    for (const hit of answer.hits) expect(expected.has(hit.id)).toBe(true)
    await expect(node.preflight(INDEX, { term })).rejects.toMatchObject({ code: ErrorCodes.QUERY_NO_ACTIVE_REPLICA })
  })

  it('answers no hits under DFS when no copy of any partition has a registration', async () => {
    const { cluster, node } = await pantryCluster(0, 30)
    for (const nodeId of ['node-a', 'node-b', 'node-c']) await cluster.watched.coordinator.deregisterNode(nodeId)
    const answer = await node.query(INDEX, { term: '"olive oil"', scoring: 'dfs' })
    expect(answer.hits).toEqual([])
    expect(answer.coverage?.queriedPartitions).toBe(0)
  })
})
