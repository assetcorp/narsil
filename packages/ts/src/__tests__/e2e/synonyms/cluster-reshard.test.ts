import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { readRebalanceRecord } from '../../../distribution/cluster/rebalance/records'
import { NarsilError } from '../../../errors'
import { waitFor } from '../../server/helpers'
import { createClusterGarage, dfsSearchOver, type GarageCluster, startGarageCluster } from './cluster-harness'
import { FIRST_RULES, garageCorpus, INDEX, registerGarageLanguage, SECOND_RULES } from './corpus'
import { expectEveryProbe } from './harness'
import { createOracle } from './oracle'

const NODES = ['node-a', 'node-b']
const CORPUS_SIZE = 800
const PARTITIONS_AFTER_THE_FIRST_CHANGE = 3
const PARTITIONS_AFTER_THE_SECOND_CHANGE = 2

const clusters: GarageCluster[] = []

beforeAll(() => {
  registerGarageLanguage()
})

afterEach(async () => {
  for (const cluster of clusters.splice(0)) await cluster.shutdown()
})

function codeOf(error: unknown): string {
  return error instanceof NarsilError ? error.code : String(error)
}

describe('a synonym set across partition count changes', () => {
  it('keeps its rules, takes a replacement under the public name, and leaves no chunk after a drop', async () => {
    const documents = garageCorpus(CORPUS_SIZE, 59)
    const cluster = await startGarageCluster(NODES)
    clusters.push(cluster)
    await createClusterGarage(cluster, 'node-a', documents, FIRST_RULES)

    await cluster.node('node-a').rebalance(INDEX, PARTITIONS_AFTER_THE_FIRST_CHANGE)
    const first = createOracle(documents, FIRST_RULES)
    for (const nodeId of NODES) {
      expect(await cluster.node(nodeId).getSynonyms(INDEX)).toEqual(FIRST_RULES)
      await expectEveryProbe(dfsSearchOver(cluster.node(nodeId)), first, `resharded, from ${nodeId}`)
    }

    await cluster.node('node-b').updateSynonyms(INDEX, SECOND_RULES)
    const second = createOracle(documents, SECOND_RULES)
    for (const nodeId of NODES) {
      expect(await cluster.node(nodeId).getSynonyms(INDEX)).toEqual(SECOND_RULES)
      await expectEveryProbe(dfsSearchOver(cluster.node(nodeId)), second, `replaced, from ${nodeId}`)
    }

    const change = cluster.node('node-b').rebalance(INDEX, PARTITIONS_AFTER_THE_SECOND_CHANGE)
    await waitFor(async () => (await readRebalanceRecord(cluster.watched.coordinator, INDEX)) !== null)
    expect(await cluster.node('node-a').updateSynonyms(INDEX, FIRST_RULES).catch(codeOf)).toBe(
      'PARTITION_REBALANCING_BACKPRESSURE',
    )
    await change
    for (const nodeId of NODES) {
      expect(await cluster.node(nodeId).getSynonyms(INDEX)).toEqual(SECOND_RULES)
      await expectEveryProbe(dfsSearchOver(cluster.node(nodeId)), second, `resharded again, from ${nodeId}`)
    }

    await cluster.node('node-a').updateSynonyms(INDEX, [])
    const none = createOracle(documents, [])
    for (const nodeId of NODES) {
      await expectEveryProbe(dfsSearchOver(cluster.node(nodeId)), none, `removed, from ${nodeId}`)
    }

    await cluster.node('node-a').dropIndex(INDEX)
    expect([...cluster.watched.liveChunks]).toEqual([])
  }, 120_000)
})
