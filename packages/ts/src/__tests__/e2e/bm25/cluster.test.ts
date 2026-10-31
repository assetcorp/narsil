import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { NarsilError } from '../../../errors'
import type { BM25Params } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import { waitFor } from '../../server/helpers'
import { type GarageCluster, PARTITION_COUNT, startGarageCluster, waitForPrimaries } from '../synonyms/cluster-harness'
import { INDEX, LANGUAGE_NAME, registerGarageLanguage, SCHEMA } from '../synonyms/corpus'
import { bm25Corpus, differsFromOracle, expectOracleScores, FULL_LIMIT, searchWith, TITLE_HEAVY } from './harness'
import { createBm25Oracle } from './oracle'

const clusters: GarageCluster[] = []
const directories: string[] = []

beforeAll(() => {
  registerGarageLanguage()
})

afterEach(async () => {
  for (const cluster of clusters.splice(0)) await cluster.shutdown()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function started(nodes: string[]): Promise<GarageCluster> {
  const cluster = await startGarageCluster(nodes)
  clusters.push(cluster)
  return cluster
}

interface CreateShape {
  partitionCount: number
  replicationFactor: number
  holders: number
}

const ONE_PARTITION: CreateShape = { partitionCount: 1, replicationFactor: 1, holders: 1 }

async function createIndex(
  cluster: GarageCluster,
  documents: ReturnType<typeof bm25Corpus>,
  shape: CreateShape,
  bm25?: BM25Params,
  via = 'node-a',
): Promise<void> {
  const node = cluster.node(via)
  await node.createIndex(
    INDEX,
    { schema: SCHEMA, language: LANGUAGE_NAME, ...(bm25 !== undefined ? { bm25 } : {}) },
    { partitionCount: shape.partitionCount, replicationFactor: shape.replicationFactor },
  )
  await waitForPrimaries(cluster, shape.holders)
  expect((await node.insertBatch(INDEX, documents)).failed).toEqual([])
}

function reader(node: ClusterNode, scoring: 'local' | 'dfs') {
  return searchWith(node, { scoring } as Partial<QueryParams>)
}

async function registerAsOlder(cluster: GarageCluster, nodeId: string): Promise<() => Promise<void>> {
  const nodes = await cluster.watched.coordinator.listNodes()
  const registration = nodes.find(node => node.nodeId === nodeId)
  if (registration === undefined) throw new Error(`no registration for ${nodeId}`)
  await cluster.watched.coordinator.registerNode({ ...registration, version: '1.0' })
  return () => cluster.watched.coordinator.registerNode(registration)
}

async function codeOf(attempt: Promise<unknown>): Promise<string> {
  const error = await attempt.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(NarsilError)
  return (error as NarsilError).code
}

describe('BM25 parameters across a cluster', () => {
  it('match the oracle under local scoring on every coordinator, at every level, once a change spreads', async () => {
    const documents = bm25Corpus(1_500, 971)
    const oracle = createBm25Oracle(documents)
    const cluster = await started(['node-a', 'node-b'])
    await createIndex(cluster, documents, ONE_PARTITION, { k1: 2 })
    const searchSetting = { b: 0.4, fields: { title: { k1: 5 } } }
    for (const nodeId of ['node-a', 'node-b']) {
      const search = reader(cluster.node(nodeId), 'local')
      await expectOracleScores(search, oracle, { k1: 2 }, undefined, `${nodeId} created`)
      await expectOracleScores(search, oracle, { k1: 2 }, searchSetting, `${nodeId} search pair`)
    }

    await cluster.node('node-a').updateBM25(INDEX, TITLE_HEAVY)
    await expectOracleScores(reader(cluster.node('node-a'), 'local'), oracle, TITLE_HEAVY, undefined, 'receiving node')
    const query = { term: 'road river', limit: 25 }
    const onNodeB = reader(cluster.node('node-b'), 'local')
    await waitFor(async () => differsFromOracle(await onNodeB(query, undefined), oracle, query, TITLE_HEAVY) === null)
    await expectOracleScores(reader(cluster.node('node-b'), 'local'), oracle, TITLE_HEAVY, undefined, 'other node')
  }, 180_000)

  it.each([
    { scoring: 'dfs' as const, partitionCount: PARTITION_COUNT, holders: 3 },
    { scoring: 'local' as const, partitionCount: 1, holders: 1 },
  ])('score one query under one setting under $scoring scoring while a change spreads', async shape => {
    const documents = bm25Corpus(1_500, 972)
    const oracle = createBm25Oracle(documents)
    const cluster = await started(['node-a', 'node-b', 'node-c'])
    await createIndex(cluster, documents, {
      partitionCount: shape.partitionCount,
      replicationFactor: 0,
      holders: shape.holders,
    })
    const first: BM25Params = { k1: 0.5, fields: { body: { b: 0.1 } } }
    const second: BM25Params = { k1: 3, fields: { title: { b: 1 } } }
    await cluster.node('node-a').updateBM25(INDEX, first)
    const query = { term: 'stone film', limit: FULL_LIMIT }
    const search = reader(cluster.node('node-b'), shape.scoring)
    await waitFor(async () => differsFromOracle(await search(query, undefined), oracle, query, first) === null)

    let changing = true
    const change = cluster
      .node('node-a')
      .updateBM25(INDEX, second)
      .finally(() => {
        changing = false
      })
    let rounds = 0
    do {
      const found = await search(query, undefined)
      const matchesOne =
        differsFromOracle(found, oracle, query, first) === null ||
        differsFromOracle(found, oracle, query, second) === null
      expect(matchesOne, `round ${rounds} mixed two settings`).toBe(true)
      rounds += 1
    } while (changing || rounds < 5)
    await change
    await waitFor(async () => differsFromOracle(await search(query, undefined), oracle, query, second) === null)
    await expectOracleScores(search, oracle, second, undefined, 'after the change')
  }, 180_000)

  it('keeps the setting and its revision through a synonym replacement and a node restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'narsil-bm25-cluster-'))
    directories.push(directory)
    const documents = bm25Corpus(800, 973)
    const oracle = createBm25Oracle(documents)
    const cluster = await started([])
    await cluster.startNode('router', ['coordinator', 'controller'])
    await cluster.startNode('node-a', ['data'], { durability: { directory } })
    await createIndex(cluster, documents, { partitionCount: 1, replicationFactor: 0, holders: 1 }, undefined, 'router')
    await cluster.node('node-a').checkpoint(INDEX)
    await cluster.node('router').updateBM25(INDEX, TITLE_HEAVY)
    await cluster.node('router').updateSynonyms(INDEX, [{ words: ['lane', 'alley'] }])
    await cluster.stopNode('node-a')
    await cluster.node('router').updateBM25(INDEX, { b: 0.1, fields: { body: { k1: 9 } } })
    const latest = { b: 0.1, fields: { body: { k1: 9 } } }
    await cluster.startNode('node-a', ['data'], { durability: { directory } })
    await waitForPrimaries(cluster, 1)

    await expectOracleScores(reader(cluster.node('router'), 'dfs'), oracle, latest, undefined, 'router')
    await expectOracleScores(reader(cluster.node('node-a'), 'dfs'), oracle, latest, undefined, 'rejoined node')
  }, 180_000)

  it('refuses a change, a tuned creation, and a search that carries a pair while a copy is on an older node', async () => {
    const documents = bm25Corpus(300, 974)
    const cluster = await started(['node-a', 'node-b'])
    await createIndex(cluster, documents, { partitionCount: 2, replicationFactor: 0, holders: 2 }, { k1: 2 })
    const node = cluster.node('node-a')
    const restore = await registerAsOlder(cluster, 'node-b')
    await waitFor(async () => {
      const code = await node.query(INDEX, { term: 'road', bm25: { k1: 3 } }).then(
        () => null,
        (error: { code?: string }) => error.code ?? null,
      )
      return code === 'BM25_NOT_READY'
    })

    expect(await codeOf(node.updateBM25(INDEX, { k1: 4 }))).toBe('BM25_NOT_READY')
    expect(await codeOf(node.preflight(INDEX, { term: 'road', bm25: { b: 0.2 } }))).toBe('BM25_NOT_READY')
    expect(
      await codeOf(
        node.createIndex('tuned', { schema: SCHEMA, bm25: { fields: { title: { k1: 3 } } } }, { partitionCount: 1 }),
      ),
    ).toBe('BM25_NOT_READY')

    const plain = await node.query(INDEX, { term: 'road', limit: 3 })
    expect(plain.hits.length).toBe(3)
    await node.createIndex('untuned', { schema: SCHEMA, bm25: { k1: 3, b: 0.5 } }, { partitionCount: 1 })

    await restore()
    await waitFor(async () =>
      node.query(INDEX, { term: 'road', bm25: { k1: 3 } }).then(
        () => true,
        () => false,
      ),
    )
    await node.updateBM25(INDEX, { k1: 5 })
    await registerAsOlder(cluster, 'node-b')
    await waitFor(async () => {
      const code = await node.query(INDEX, { term: 'road' }).then(
        () => null,
        (error: { code?: string }) => error.code ?? null,
      )
      return code === 'BM25_NOT_READY'
    })
  }, 120_000)

  it('skips a copy on a node with no registration for a query that carries a pair, and a dead node blocks nothing', async () => {
    const documents = bm25Corpus(600, 975)
    const oracle = createBm25Oracle(documents)
    const cluster = await started(['node-a', 'node-b'])
    await createIndex(cluster, documents, { partitionCount: 1, replicationFactor: 1, holders: 1 })
    const table = await cluster.watched.coordinator.getAllocation(INDEX)
    const assignment = table?.assignments.get(0)
    const holders = [assignment?.primary, ...(assignment?.replicas ?? [])].filter(holder => typeof holder === 'string')
    expect(holders.length).toBe(2)
    await waitFor(async () => {
      const current = (await cluster.watched.coordinator.getAllocation(INDEX))?.assignments.get(0)
      return current?.state === 'ACTIVE' && current.replicas.length === 1
    })

    await cluster.watched.coordinator.deregisterNode('node-b')
    const node = cluster.node('node-a')
    await waitFor(async () => {
      cluster.exchanges.length = 0
      const query = { term: 'road river', limit: 25 }
      const searchSetting = { k1: 0.7 }
      const found = await searchWith(node, { scoring: 'local' } as Partial<QueryParams>)(query, searchSetting).catch(
        () => null,
      )
      if (found === null || differsFromOracle(found, oracle, query, undefined, searchSetting) !== null) return false
      return cluster.exchanges.every(
        exchange => exchange.target !== 'node-b' || !exchange.request.type.startsWith('query.'),
      )
    })
  }, 120_000)

  it('refuses hostile values on the coordinating node with the same codes as one engine', async () => {
    const documents = bm25Corpus(200, 976)
    const cluster = await started(['node-a', 'node-b'])
    await createIndex(cluster, documents, { partitionCount: 2, replicationFactor: 0, holders: 2 })
    const node = cluster.node('node-a')
    for (const key of ['__proto__', 'constructor', 'toString']) {
      const bm25 = JSON.parse(`{"fields":{"${key}":{"k1":77}}}`) as BM25Params
      expect(await codeOf(node.query(INDEX, { term: 'road', bm25 })), key).toBe('SEARCH_INVALID_FIELD')
      expect(await codeOf(node.preflight(INDEX, { term: 'road', bm25 })), key).toBe('SEARCH_INVALID_FIELD')
      expect(await codeOf(node.updateBM25(INDEX, bm25)), key).toBe('CONFIG_INVALID')
      expect(await codeOf(node.createIndex('hostile', { schema: SCHEMA, bm25 })), key).toBe('CONFIG_INVALID')
    }
    for (const bm25 of [{ k1: Number.NaN }, { k1: -1 }, { k1: 1_001 }, { b: 2 }] as BM25Params[]) {
      expect(await codeOf(node.query(INDEX, { term: 'road', bm25 }))).toBe('CONFIG_INVALID')
      expect(await codeOf(node.updateBM25(INDEX, bm25))).toBe('CONFIG_INVALID')
      expect(await codeOf(node.createIndex('hostile', { schema: SCHEMA, bm25 }))).toBe('CONFIG_INVALID')
    }
    expect(await codeOf(node.updateBM25('absent', { k1: 1 }))).toBe('INDEX_NOT_FOUND')
  }, 60_000)
})
