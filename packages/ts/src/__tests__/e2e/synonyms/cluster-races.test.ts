import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { SynonymRule } from '../../../types/synonyms'
import {
  createClusterGarage,
  dfsSearchOver,
  type GarageCluster,
  type Hook,
  startGarageCluster,
  waitForPrimaries,
} from './cluster-harness'
import {
  CODE_WORDS,
  FIRST_RULES,
  garageCorpus,
  INDEX,
  LANGUAGE_NAME,
  registerGarageLanguage,
  SCHEMA,
  SECOND_RULES,
} from './corpus'
import { expectEveryProbe } from './harness'
import { createOracle } from './oracle'

const NODES = ['node-a', 'node-b', 'node-c']
const REPLACEMENT_ATTEMPTS = 5

const clusters: GarageCluster[] = []

beforeAll(() => {
  registerGarageLanguage()
})

afterEach(async () => {
  for (const cluster of clusters.splice(0)) await cluster.shutdown()
})

async function startedWithIndex(documentCount: number, seed: number): Promise<GarageCluster> {
  const cluster = await startGarageCluster(NODES)
  clusters.push(cluster)
  await createClusterGarage(cluster, 'node-a', garageCorpus(documentCount, seed), FIRST_RULES)
  return cluster
}

async function refusalOf(action: Promise<unknown>): Promise<NarsilError> {
  const caught = await action.then(
    () => null,
    (error: unknown) => error,
  )
  expect(caught).toBeInstanceOf(NarsilError)
  return caught as NarsilError
}

function generationsOf(chunks: ReadonlySet<string>): Set<string> {
  return new Set([...chunks].map(key => key.split('/').slice(0, -1).join('/')))
}

describe('a synonym set read while another node replaces it', () => {
  it('reads the metadata again when the chunks it was reading are deleted, and returns the new set', async () => {
    const cluster = await startedWithIndex(200, 101)
    cluster.watched.beforeChunkRead = () => cluster.node('node-b').updateSynonyms(INDEX, SECOND_RULES)
    expect(await cluster.node('node-a').getSynonyms(INDEX)).toEqual(SECOND_RULES)
    expect(cluster.watched.beforeChunkRead).toBeNull()
    expect(generationsOf(cluster.watched.liveChunks).size).toBe(1)
  }, 60_000)

  it('refuses with CONTROLLER_METADATA_INVALID when a chunk is missing and the metadata still points at it', async () => {
    const cluster = await startedWithIndex(200, 102)
    const [chunk] = [...cluster.watched.liveChunks]
    await cluster.watched.coordinator.delete(chunk)
    const refusal = await refusalOf(cluster.node('node-b').getSynonyms(INDEX))
    expect(refusal.code).toBe(ErrorCodes.CONTROLLER_METADATA_INVALID)
  }, 60_000)
})

describe('a synonym replacement that races another change to the index', () => {
  it('answers INDEX_NOT_FOUND when the index is dropped and created again before the new set is stored', async () => {
    const documents = garageCorpus(300, 103)
    const cluster = await startedWithIndex(300, 103)
    cluster.watched.beforeChunkWrite = async () => {
      await cluster.node('node-b').dropIndex(INDEX)
      await cluster
        .node('node-b')
        .createIndex(INDEX, { schema: SCHEMA, language: LANGUAGE_NAME }, { partitionCount: 6, replicationFactor: 0 })
      await waitForPrimaries(cluster, NODES.length)
      const inserted = await cluster.node('node-b').insertBatch(INDEX, documents)
      expect(inserted.failed).toEqual([])
    }

    const refusal = await refusalOf(cluster.node('node-a').updateSynonyms(INDEX, SECOND_RULES))
    expect(refusal.code).toBe(ErrorCodes.INDEX_NOT_FOUND)
    expect(await cluster.node('node-c').getSynonyms(INDEX)).toEqual([])
    expect(cluster.watched.liveChunks.size).toBe(0)
    await expectEveryProbe(dfsSearchOver(cluster.node('node-c')), createOracle(documents, []), 'created again')
  }, 120_000)

  it('gives up with settings_contention after five lost swaps, keeping the last set that won and none of its own chunks', async () => {
    const cluster = await startedWithIndex(200, 104)
    let competitors = 0
    let lastWinner: SynonymRule[] = FIRST_RULES
    const compete: Hook = async () => {
      competitors++
      lastWinner = [{ words: ['road', CODE_WORDS[competitors]] }]
      await cluster.node('node-b').updateSynonyms(INDEX, lastWinner)
      cluster.watched.beforeConfigSwap = compete
    }
    cluster.watched.beforeConfigSwap = compete

    const refusal = await refusalOf(cluster.node('node-a').updateSynonyms(INDEX, SECOND_RULES))
    cluster.watched.beforeConfigSwap = null
    expect(refusal.code).toBe(ErrorCodes.CLUSTER_WRITE_BLOCKED)
    expect(refusal.details).toMatchObject({ reason: 'settings_contention', attempts: REPLACEMENT_ATTEMPTS })
    expect(competitors).toBe(REPLACEMENT_ATTEMPTS)
    for (const nodeId of NODES) expect(await cluster.node(nodeId).getSynonyms(INDEX)).toEqual(lastWinner)
    expect(generationsOf(cluster.watched.liveChunks).size).toBe(1)
  }, 120_000)

  it('leaves every node searching with the same stored set after two nodes replace it at once', async () => {
    const documents = garageCorpus(600, 105)
    const cluster = await startGarageCluster(NODES)
    clusters.push(cluster)
    await createClusterGarage(cluster, 'node-a', documents, FIRST_RULES)

    const outcomes = await Promise.allSettled([
      cluster.node('node-a').updateSynonyms(INDEX, SECOND_RULES),
      cluster.node('node-b').updateSynonyms(INDEX, [{ words: ['stone', 'river'] }]),
    ])
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect((outcome.reason as NarsilError).details).toMatchObject({ reason: 'settings_contention' })
      }
    }
    expect(outcomes.some(outcome => outcome.status === 'fulfilled')).toBe(true)

    const stored = await cluster.node('node-c').getSynonyms(INDEX)
    const oracle = createOracle(documents, stored)
    for (const nodeId of NODES) await expectEveryProbe(dfsSearchOver(cluster.node(nodeId)), oracle, nodeId)
    expect(generationsOf(cluster.watched.liveChunks).size).toBe(1)
  }, 180_000)
})
