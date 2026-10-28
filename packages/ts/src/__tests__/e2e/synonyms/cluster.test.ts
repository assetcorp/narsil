import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import {
  createClusterGarage,
  dfsSearchOver,
  type GarageCluster,
  startGarageCluster,
  waitForPrimaries,
} from './cluster-harness'
import { FIRST_RULES, garageCorpus, INDEX, registerGarageLanguage, SECOND_RULES } from './corpus'
import { expectEveryProbe, probeQueries } from './harness'
import { createOracle } from './oracle'

const CORPUS_SIZE = 1_200
const NODES = ['node-a', 'node-b', 'node-c']

const clusters: GarageCluster[] = []
const directories: string[] = []

beforeAll(() => {
  registerGarageLanguage()
})

afterEach(async () => {
  for (const cluster of clusters.splice(0)) await cluster.shutdown()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function started(nodeIds: readonly string[]): Promise<GarageCluster> {
  const cluster = await startGarageCluster(nodeIds)
  clusters.push(cluster)
  return cluster
}

function generationsOf(chunks: ReadonlySet<string>): Set<string> {
  return new Set([...chunks].map(key => key.split('/').slice(0, -1).join('/')))
}

async function codeOf(action: Promise<unknown>): Promise<NarsilError> {
  const caught = await action.then(
    () => null,
    (error: unknown) => error,
  )
  expect(caught).toBeInstanceOf(NarsilError)
  return caught as NarsilError
}

describe('a synonym set on a three-node cluster under DFS scoring', () => {
  it('matches the oracle from every node, through a replacement made while queries run, and after removal', async () => {
    const documents = garageCorpus(CORPUS_SIZE, 81)
    const cluster = await started(NODES)
    await createClusterGarage(cluster, 'node-a', documents, FIRST_RULES)
    await expectEveryProbe(dfsSearchOver(cluster.node('node-b')), createOracle(documents, FIRST_RULES), 'created')
    expect(generationsOf(cluster.watched.liveChunks).size).toBe(1)

    let replaced = false
    const queries = (async () => {
      let sent = 0
      while (!replaced || sent === 0) {
        for (const query of probeQueries().slice(0, 12)) {
          await dfsSearchOver(cluster.node('node-c'))(query)
          await new Promise(resolve => setImmediate(resolve))
        }
        sent++
      }
      return sent
    })()
    await cluster.node('node-a').updateSynonyms(INDEX, SECOND_RULES)
    replaced = true
    expect(await queries).toBeGreaterThan(0)

    const second = createOracle(documents, SECOND_RULES)
    for (const nodeId of NODES) {
      await expectEveryProbe(dfsSearchOver(cluster.node(nodeId)), second, `replaced, from ${nodeId}`)
      expect(await cluster.node(nodeId).getSynonyms(INDEX)).toEqual(SECOND_RULES)
    }
    expect(generationsOf(cluster.watched.liveChunks).size).toBe(1)

    await cluster.node('node-b').updateSynonyms(INDEX, [])
    await expectEveryProbe(dfsSearchOver(cluster.node('node-c')), createOracle(documents, []), 'removed')
    expect(await cluster.node('node-a').getSynonyms(INDEX)).toEqual([])
    expect(cluster.watched.liveChunks.size).toBe(0)

    await cluster.node('node-c').dropIndex(INDEX)
    expect(cluster.watched.liveChunks.size).toBe(0)
  }, 240_000)

  it('answers QUERY_NODE_TIMEOUT when a holder is unreachable, keeps the new set stored, and applies it on retry', async () => {
    const documents = garageCorpus(400, 82)
    const cluster = await started(NODES)
    await createClusterGarage(cluster, 'node-a', documents, FIRST_RULES)
    const unreachable = cluster.network.getTransport('node-c')
    if (unreachable === undefined) throw new Error('node-c has no transport')
    cluster.network.unregister('node-c')

    const error = await codeOf(cluster.node('node-a').updateSynonyms(INDEX, SECOND_RULES))
    expect(error.code).toBe(ErrorCodes.QUERY_NODE_TIMEOUT)
    expect(error.details.targetNodeId).toBe('node-c')
    expect(await cluster.node('node-b').getSynonyms(INDEX)).toEqual(SECOND_RULES)
    expect(generationsOf(cluster.watched.liveChunks).size).toBe(1)

    cluster.network.register('node-c', unreachable)
    await cluster.node('node-a').updateSynonyms(INDEX, SECOND_RULES)
    await expectEveryProbe(dfsSearchOver(cluster.node('node-b')), createOracle(documents, SECOND_RULES), 'retried')
    expect(generationsOf(cluster.watched.liveChunks).size).toBe(1)
  }, 120_000)

  it('gives a node that rejoins with its own copy the set that was replaced while it was away', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'narsil-synonym-cluster-'))
    directories.push(directory)
    const documents = garageCorpus(600, 83)
    const cluster = await started([])
    await cluster.startNode('router', ['coordinator', 'controller'])
    await cluster.startNode('node-a', ['data'], { durability: { directory } })
    await createClusterGarage(cluster, 'router', documents, FIRST_RULES, 1)
    await cluster.node('node-a').checkpoint(INDEX)
    await cluster.stopNode('node-a')

    await cluster
      .node('router')
      .updateSynonyms(INDEX, SECOND_RULES)
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(NarsilError)
        expect((error as NarsilError).code).toBe(ErrorCodes.QUERY_NODE_TIMEOUT)
      })
    expect(await cluster.node('router').getSynonyms(INDEX)).toEqual(SECOND_RULES)

    await cluster.startNode('node-a', ['data'], { durability: { directory } })
    await waitForPrimaries(cluster, 1)
    await expectEveryProbe(dfsSearchOver(cluster.node('router')), createOracle(documents, SECOND_RULES), 'rejoined')
  }, 120_000)
})
