import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { dfsSearchOver, type GarageCluster } from '../synonyms/cluster-harness'
import { FIRST_RULES, INDEX, registerGarageLanguage } from '../synonyms/corpus'
import { expectEveryProbe } from '../synonyms/harness'
import { createOracle } from '../synonyms/oracle'
import { clusterWithRouter, createAndFill } from './harness'

let cluster: GarageCluster | null = null

beforeAll(() => {
  registerGarageLanguage()
})

afterEach(async () => {
  await cluster?.shutdown()
  cluster = null
})

describe('an index dropped once from a node that did not create it', () => {
  it('releases its allocation and chunks, and the same name serves only the new documents', async () => {
    cluster = await clusterWithRouter()
    await createAndFill(cluster, 'router', 400, FIRST_RULES)

    await cluster.node('node-b').dropIndex(INDEX)
    expect(await cluster.watched.coordinator.getAllocation(INDEX)).toBeNull()
    expect(cluster.watched.liveChunks.size).toBe(0)

    const documents = await createAndFill(cluster, 'node-c', 401, [])
    const oracle = createOracle(documents, [])
    await expectEveryProbe(dfsSearchOver(cluster.node('router')), oracle, 'after the drop')
  }, 60_000)
})
