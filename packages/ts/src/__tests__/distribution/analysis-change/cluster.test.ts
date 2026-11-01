import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { generateId } from '../../../core/id-generator'
import { metadataWithPendingAnalysis } from '../../../distribution/cluster/analysis-metadata'
import { indexConfigKey, readIndexMetadataSnapshot } from '../../../distribution/cluster/index-metadata'
import { readRebalanceRecord } from '../../../distribution/cluster/rebalance/records'
import { clusterNodeEngine } from '../../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { QueryMessageTypes } from '../../../distribution/transport/types'
import { NarsilError } from '../../../errors'
import { type GarageCluster, startGarageCluster, waitForPrimaries } from '../../e2e/synonyms/cluster-harness'
import { INDEX } from '../../e2e/synonyms/corpus'
import {
  ChangeOracle,
  DASHES_SETTINGS,
  DASHES_TOKENIZER,
  NO_RIVER_SETTINGS,
  OLD_SETTINGS,
  type OracleSettings,
  PLAIN_LANGUAGE,
  PROBES,
  RIVER_STOP_WORDS,
  registerFixtures,
  STEMMING_LANGUAGE,
  STEMMING_SETTINGS,
  seededRandom,
  sentence,
} from '../../engine/analysis-change/oracle'
import { waitFor } from '../../server/helpers'

const SCHEMA = { title: 'string' as const }
const PARTITIONS = 3
const RESULT_LIMIT = 10_000

const clusters: GarageCluster[] = []
const directories: string[] = []

beforeAll(() => {
  registerFixtures()
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

async function filled(
  cluster: GarageCluster,
  via: string,
  documents: number,
  replicationFactor = 0,
  holders = cluster.nodes.size,
): Promise<ChangeOracle> {
  const oracle = new ChangeOracle()
  const random = seededRandom(31)
  const batch = []
  for (let i = 0; i < documents; i++) {
    const title = sentence(random)
    oracle.write(`doc-${i}`, title)
    batch.push({ id: `doc-${i}`, title })
  }
  await cluster
    .node(via)
    .createIndex(INDEX, { schema: SCHEMA, language: PLAIN_LANGUAGE }, { partitionCount: PARTITIONS, replicationFactor })
  await waitForPrimaries(cluster, holders)
  expect((await cluster.node(via).insertBatch(INDEX, batch)).failed).toEqual([])
  await waitFor(async () => {
    const table = await cluster.watched.coordinator.getAllocation(INDEX)
    const assignments = [...(table?.assignments.values() ?? [])]
    return assignments.every(each => each.replicas.every(replica => each.inSyncSet.includes(replica)))
  })
  return oracle
}

async function hitsOf(node: ClusterNode, term: string): Promise<string[]> {
  const page = await node.query(INDEX, { term, limit: RESULT_LIMIT })
  return page.hits.map(hit => hit.id).sort()
}

async function expectMatches(node: ClusterNode, oracle: ChangeOracle, settings: OracleSettings): Promise<void> {
  for (const probe of PROBES) {
    expect({ probe, hits: await hitsOf(node, probe) }).toEqual({ probe, hits: oracle.matches(probe, settings) })
  }
}

function underOneOf(hits: string[], oracle: ChangeOracle, probe: string, settings: OracleSettings[]): boolean {
  const joined = hits.join('\n')
  return settings.some(each => oracle.matches(probe, each).join('\n') === joined)
}

function codeOf(error: unknown): string {
  return error instanceof NarsilError ? error.code : String(error)
}

async function publishedGeneration(cluster: GarageCluster): Promise<number> {
  const snapshot = await readIndexMetadataSnapshot(cluster.watched.coordinator, INDEX)
  return snapshot?.settings?.analysisGeneration ?? 0
}

async function pendingWritten(cluster: GarageCluster): Promise<void> {
  await waitFor(async () => {
    const snapshot = await readIndexMetadataSnapshot(cluster.watched.coordinator, INDEX)
    return snapshot?.settings?.pendingAnalysis !== undefined
  })
}

describe('changing the analysis of a cluster index', () => {
  it('matches the oracle on every coordinator after a tokeniser, a stop word, and a language change', async () => {
    const cluster = await started(['node-a', 'node-b', 'node-c'])
    const oracle = await filled(cluster, 'node-a', 600)
    const readers = ['node-a', 'node-b', 'node-c'].map(id => cluster.node(id))
    for (const reader of readers) await expectMatches(reader, oracle, OLD_SETTINGS)

    await cluster.node('node-b').changeAnalysis(INDEX, { tokenizer: DASHES_TOKENIZER })
    for (const reader of readers) await expectMatches(reader, oracle, DASHES_SETTINGS)
    expect(await publishedGeneration(cluster)).toBe(1)

    await clusterNodeEngine(cluster.node('node-c')).changeAnalysis(INDEX, {
      tokenizer: null,
      stopWords: RIVER_STOP_WORDS,
    })
    for (const reader of readers) await expectMatches(reader, oracle, NO_RIVER_SETTINGS)

    await cluster.node('node-a').changeAnalysis(INDEX, { language: STEMMING_LANGUAGE, stopWords: null })
    for (const reader of readers) await expectMatches(reader, oracle, STEMMING_SETTINGS)
    expect(await publishedGeneration(cluster)).toBe(3)
  }, 120_000)

  it('completes with no new generation for the settings that the index holds', async () => {
    const cluster = await started(['node-a', 'node-b'])
    await filled(cluster, 'node-a', 20)
    await cluster.node('node-b').changeAnalysis(INDEX, { language: PLAIN_LANGUAGE })
    expect(await publishedGeneration(cluster)).toBe(0)
  }, 60_000)

  it('answers each search under one set of settings and keeps every write while a change spreads', async () => {
    const cluster = await started(['node-a', 'node-b', 'node-c'])
    const oracle = await filled(cluster, 'node-a', 4_000, 1)
    const random = seededRandom(5)
    let changing = true
    const change = cluster
      .node('node-c')
      .changeAnalysis(INDEX, { tokenizer: DASHES_TOKENIZER })
      .finally(() => {
        changing = false
      })
    let written = 0
    while (changing || written < 5) {
      const title = sentence(random)
      const id = `live-${written}`
      written += 1
      await cluster.node('node-a').insert(INDEX, { title }, id)
      oracle.write(id, title)
      const hits = await hitsOf(cluster.node('node-b'), 'wall')
      expect(underOneOf(hits, oracle, 'wall', [OLD_SETTINGS, DASHES_SETTINGS])).toBe(true)
      await new Promise(resolve => setImmediate(resolve))
    }
    await change
    await expectMatches(cluster.node('node-b'), oracle, DASHES_SETTINGS)
  }, 120_000)

  it('finishes the change when the node that asked for it dies', async () => {
    const cluster = await started(['node-a', 'node-b', 'node-c'])
    const oracle = await filled(cluster, 'node-a', 2_000, 1)
    const asked = cluster.node('node-b').changeAnalysis(INDEX, { tokenizer: DASHES_TOKENIZER }).catch(codeOf)
    await pendingWritten(cluster)
    await cluster.stopNode('node-b')
    await asked
    await waitFor(async () => (await publishedGeneration(cluster)) === 1)
    await waitFor(async () => {
      const hits = await hitsOf(cluster.node('node-a'), 'wall')
      return underOneOf(hits, oracle, 'wall', [DASHES_SETTINGS])
    })
    await expectMatches(cluster.node('node-c'), oracle, DASHES_SETTINGS)
  }, 120_000)

  it('catches up a node that returns from disk after the change, answering no search under the old settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'narsil-analysis-cluster-'))
    directories.push(directory)
    const cluster = await started([])
    await cluster.startNode('router', ['coordinator', 'controller'])
    await cluster.startNode('node-a', ['data'], { durability: { directory } })
    const oracle = await filled(cluster, 'router', 800, 0, 1)
    await cluster.node('node-a').checkpoint(INDEX)
    await cluster.stopNode('node-a')
    await waitFor(async () => (await cluster.watched.coordinator.listNodes()).length === 1)

    await cluster.node('router').changeAnalysis(INDEX, { tokenizer: DASHES_TOKENIZER })
    expect(await publishedGeneration(cluster)).toBe(1)

    await cluster.startNode('node-a', ['data'], { durability: { directory } })
    await waitForPrimaries(cluster, 1)
    await waitFor(async () => {
      const page = await cluster
        .node('router')
        .query(INDEX, { term: 'wall', limit: RESULT_LIMIT })
        .catch(() => null)
      return page?.coverage?.queriedPartitions === PARTITIONS
    })
    await expectMatches(cluster.node('router'), oracle, DASHES_SETTINGS)
  }, 120_000)

  it('restarts a node during a change and still matches under one set of settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'narsil-analysis-cluster-'))
    directories.push(directory)
    const durabilityOf = (nodeId: string) => ({ durability: { directory: join(directory, nodeId) } })
    const cluster = await started([])
    await cluster.startNode('node-a', ['data', 'coordinator', 'controller'], durabilityOf('node-a'))
    await cluster.startNode('node-b', ['data', 'coordinator'], durabilityOf('node-b'))
    await cluster.startNode('node-c', ['data', 'coordinator'], durabilityOf('node-c'))
    const oracle = await filled(cluster, 'node-a', 3_000, 1)
    await cluster.node('node-c').checkpoint(INDEX)
    const change = cluster.node('node-a').changeAnalysis(INDEX, { tokenizer: DASHES_TOKENIZER })
    await pendingWritten(cluster)
    await cluster.stopNode('node-c')
    const probe = await hitsOf(cluster.node('node-b'), 'wall')
    expect(underOneOf(probe, oracle, 'wall', [OLD_SETTINGS, DASHES_SETTINGS])).toBe(true)
    await cluster.startNode('node-c', ['data', 'coordinator'], durabilityOf('node-c'))
    await change
    for (const reader of ['node-a', 'node-b', 'node-c']) {
      await waitFor(async () => {
        const hits = await hitsOf(cluster.node(reader), 'wall').catch(() => null)
        return hits !== null && underOneOf(hits, oracle, 'wall', [DASHES_SETTINGS])
      })
    }
  }, 120_000)

  it('lets the latest of two changes win and tells the first caller', async () => {
    const cluster = await started(['node-a', 'node-b'])
    const oracle = await filled(cluster, 'node-a', 3_000)
    const first = cluster.node('node-a').changeAnalysis(INDEX, { tokenizer: DASHES_TOKENIZER }).catch(codeOf)
    await pendingWritten(cluster)
    await cluster.node('node-b').changeAnalysis(INDEX, { stopWords: RIVER_STOP_WORDS })
    expect(await first).toBe('ANALYSIS_CHANGE_REPLACED')
    await expectMatches(cluster.node('node-a'), oracle, NO_RIVER_SETTINGS)
    expect(await publishedGeneration(cluster)).toBe(2)
  }, 120_000)

  it.each<[string, Record<string, unknown>, string]>([
    ['language', { language: 'nowhere-language' }, 'LANGUAGE_NOT_SUPPORTED'],
    ['tokeniser', { tokenizer: 'nowhere-tokenizer' }, 'CONFIG_INVALID'],
    ['stop word set', { stopWords: 'nowhere-stop-words' }, 'CONFIG_INVALID'],
  ])(
    'refuses an unregistered %s and keeps answering',
    async (_kind, change, code) => {
      const cluster = await started(['node-a'])
      const oracle = await filled(cluster, 'node-a', 30)
      expect(await cluster.node('node-a').changeAnalysis(INDEX, change).catch(codeOf)).toBe(code)
      await expectMatches(cluster.node('node-a'), oracle, OLD_SETTINGS)
    },
    60_000,
  )

  it('records a failure and drops the new terms where a node refuses a pending name', async () => {
    const cluster = await started(['node-a', 'node-b'])
    const oracle = await filled(cluster, 'node-a', 50)
    const { coordinator } = cluster.watched
    const snapshot = await readIndexMetadataSnapshot(coordinator, INDEX)
    if (snapshot === null) throw new Error('no metadata')
    const changeId = generateId()
    await coordinator.compareAndSet(
      indexConfigKey(INDEX),
      snapshot.bytes,
      metadataWithPendingAnalysis(snapshot, { changeId, generation: 1, language: 'registered-on-no-node' }),
    )
    await waitFor(async () => {
      const latest = await readIndexMetadataSnapshot(coordinator, INDEX)
      return latest?.settings?.analysisFailure?.changeId === changeId
    })
    const latest = await readIndexMetadataSnapshot(coordinator, INDEX)
    expect(latest?.settings?.pendingAnalysis).toBeUndefined()
    expect(latest?.settings?.analysisFailure?.code).toBe('LANGUAGE_NOT_SUPPORTED')
    await expectMatches(cluster.node('node-b'), oracle, OLD_SETTINGS)
    await cluster.node('node-a').changeAnalysis(INDEX, { stopWords: RIVER_STOP_WORDS })
    await expectMatches(cluster.node('node-b'), oracle, NO_RIVER_SETTINGS)
  }, 60_000)

  it('refuses a change while a registered node runs an older version', async () => {
    const cluster = await started(['node-a', 'node-b'])
    await filled(cluster, 'node-a', 20)
    const nodes = await cluster.watched.coordinator.listNodes()
    const registration = nodes.find(node => node.nodeId === 'node-b')
    if (registration === undefined) throw new Error('no registration')
    await cluster.watched.coordinator.registerNode({ ...registration, version: '1.0' })
    expect(
      await cluster
        .node('node-a')
        .changeAnalysis(INDEX, { stopWords: ['river'] })
        .catch(codeOf),
    ).toBe('ANALYSIS_CHANGE_NOT_READY')
    await cluster.watched.coordinator.registerNode(registration)
  }, 60_000)

  it('refuses a partition count change during a change, and a change during a partition count change', async () => {
    const cluster = await started(['node-a', 'node-b'])
    const oracle = await filled(cluster, 'node-a', 4_000)
    const change = cluster.node('node-a').changeAnalysis(INDEX, { tokenizer: DASHES_TOKENIZER })
    await pendingWritten(cluster)
    expect(await cluster.node('node-b').rebalance(INDEX, 2).catch(codeOf)).toBe('PARTITION_REBALANCING_BACKPRESSURE')
    await change
    const rebalance = cluster.node('node-b').rebalance(INDEX, 2)
    await waitFor(async () => (await readRebalanceRecord(cluster.watched.coordinator, INDEX)) !== null)
    expect(
      await cluster
        .node('node-a')
        .changeAnalysis(INDEX, { stopWords: ['river'] })
        .catch(codeOf),
    ).toBe('PARTITION_REBALANCING_BACKPRESSURE')
    await rebalance
    await expectMatches(cluster.node('node-a'), oracle, DASHES_SETTINGS)
    await cluster.node('node-b').changeAnalysis(INDEX, { tokenizer: null })
    await expectMatches(cluster.node('node-a'), oracle, OLD_SETTINGS)
  }, 120_000)

  it('finishes changes of two indexes that nodes start in opposite orders', async () => {
    const cluster = await started(['node-a', 'node-b'])
    const oracle = await filled(cluster, 'node-a', 2_000)
    const second = 'garage-annex'
    await cluster
      .node('node-a')
      .createIndex(second, { schema: SCHEMA, language: PLAIN_LANGUAGE }, { partitionCount: PARTITIONS })
    await waitFor(async () => {
      const table = await cluster.watched.coordinator.getAllocation(second)
      const assignments = [...(table?.assignments.values() ?? [])]
      return assignments.length === PARTITIONS && assignments.every(each => each.state === 'ACTIVE')
    })
    await cluster.node('node-a').insert(second, { title: 'wall-river' }, 'annex-0')
    await Promise.all([
      cluster.node('node-a').changeAnalysis(INDEX, { tokenizer: DASHES_TOKENIZER }),
      cluster.node('node-b').changeAnalysis(second, { tokenizer: DASHES_TOKENIZER }),
    ])
    await expectMatches(cluster.node('node-b'), oracle, DASHES_SETTINGS)
    const annex = await cluster.node('node-a').query(second, { term: 'river' })
    expect(annex.hits.map(hit => hit.id)).toEqual(['annex-0'])
  }, 60_000)

  it('drops an index during a change, tells the caller, and creates that name again', async () => {
    const cluster = await started(['node-a', 'node-b'])
    await filled(cluster, 'node-a', 3_000)
    const change = cluster.node('node-a').changeAnalysis(INDEX, { tokenizer: DASHES_TOKENIZER }).catch(codeOf)
    await pendingWritten(cluster)
    await cluster.node('node-b').dropIndex(INDEX)
    expect(['INDEX_NOT_FOUND', 'ANALYSIS_CHANGE_REPLACED']).toContain(await change)
    await waitFor(async () => (await readIndexMetadataSnapshot(cluster.watched.coordinator, INDEX)) === null)
    const oracle = await filled(cluster, 'node-a', 20)
    await expectMatches(cluster.node('node-b'), oracle, OLD_SETTINGS)
  }, 60_000)

  it('refuses a search that asks for a generation the node does not hold, naming the one it holds', async () => {
    const cluster = await started(['node-a', 'node-b'])
    await filled(cluster, 'node-a', 30)
    await cluster.node('node-a').changeAnalysis(INDEX, { stopWords: RIVER_STOP_WORDS })
    await cluster.node('node-a').query(INDEX, { term: 'wall' })
    await cluster.node('node-b').query(INDEX, { term: 'wall' })
    const transport = cluster.transports.get('node-a')
    if (transport === undefined) throw new Error('no transport')
    for (const asked of [0, 99]) {
      const answer = await transport.send('node-b', {
        type: QueryMessageTypes.SUGGEST,
        sourceId: 'node-a',
        requestId: generateId(),
        payload: encode({ indexName: INDEX, partitionIds: [0], prefix: 'wa', limit: 5, analysisGeneration: asked }),
      })
      expect(answer.type.endsWith('.error')).toBe(true)
      expect(decode(answer.payload)).toMatchObject({
        code: 'ANALYSIS_GENERATION_MISSING',
        details: { heldGeneration: 1 },
      })
    }
  }, 60_000)
})
