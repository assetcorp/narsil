import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { SynonymRule } from '../../../types/synonyms'
import { dfsSearchOver, type GarageCluster } from '../synonyms/cluster-harness'
import { FIRST_RULES, INDEX, registerGarageLanguage, SECOND_RULES } from '../synonyms/corpus'
import { expectEveryProbe } from '../synonyms/harness'
import { createOracle } from '../synonyms/oracle'
import { clusterWithRouter, createAndFill } from './harness'

const DROP_WAIT_MS = 30_000

const clusters: GarageCluster[] = []

beforeAll(() => {
  registerGarageLanguage()
})

afterEach(async () => {
  for (const cluster of clusters.splice(0)) await cluster.shutdown()
})

describe('an index dropped and created again under the same name', () => {
  it('creates straight after each acknowledged drop, from any node, and serves only the new documents', async () => {
    const cluster = await clusterWithRouter()
    clusters.push(cluster)
    const cycles: Array<{ creator: string; dropper: string; synonyms: SynonymRule[] }> = [
      { creator: 'router', dropper: 'node-b', synonyms: FIRST_RULES },
      { creator: 'node-c', dropper: 'router', synonyms: [] },
      { creator: 'router', dropper: 'node-a', synonyms: SECOND_RULES },
      { creator: 'node-b', dropper: 'node-c', synonyms: FIRST_RULES },
      { creator: 'node-a', dropper: 'node-a', synonyms: [] },
    ]
    for (const [at, cycle] of cycles.entries()) {
      const documents = await createAndFill(cluster, cycle.creator, 200 + at, cycle.synonyms)
      const oracle = createOracle(documents, cycle.synonyms)
      await expectEveryProbe(dfsSearchOver(cluster.node('router')), oracle, `cycle ${at} from router`)
      await expectEveryProbe(dfsSearchOver(cluster.node(cycle.dropper)), oracle, `cycle ${at} from ${cycle.dropper}`)
      expect(await cluster.node(cycle.dropper).getSynonyms(INDEX)).toEqual(cycle.synonyms)

      await cluster.node(cycle.dropper).dropIndex(INDEX)
      expect(await cluster.watched.coordinator.getAllocation(INDEX)).toBeNull()
      expect(cluster.watched.liveChunks.size).toBe(0)
    }
  }, 240_000)

  it('answers QUERY_NODE_TIMEOUT while a holder stays unreachable, and a retried drop completes once it confirms', async () => {
    const cluster = await clusterWithRouter()
    clusters.push(cluster)
    await createAndFill(cluster, 'node-a', 300, FIRST_RULES)
    const unreachable = cluster.network.getTransport('node-c')
    if (unreachable === undefined) throw new Error('node-c has no transport')
    cluster.network.unregister('node-c')

    const started = Date.now()
    const refusal = await cluster
      .node('node-a')
      .dropIndex(INDEX)
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(refusal).toBeInstanceOf(NarsilError)
    expect((refusal as NarsilError).code).toBe(ErrorCodes.QUERY_NODE_TIMEOUT)
    expect((refusal as NarsilError).details).toMatchObject({ indexName: INDEX, pendingNodeIds: ['node-c'] })
    expect(Date.now() - started).toBeGreaterThanOrEqual(DROP_WAIT_MS)
    expect(
      await cluster
        .node('node-b')
        .getSynonyms(INDEX)
        .catch((error: NarsilError) => error.code),
    ).toBe(ErrorCodes.INDEX_NOT_FOUND)

    let retryOutcome: 'pending' | 'resolved' | NarsilError = 'pending'
    const retried = cluster
      .node('node-b')
      .dropIndex(INDEX)
      .then(
        () => {
          retryOutcome = 'resolved'
        },
        (error: NarsilError) => {
          retryOutcome = error
        },
      )
    await new Promise(resolve => setTimeout(resolve, 1_000))
    expect(retryOutcome).toBe('pending')

    cluster.network.register('node-c', unreachable)
    await retried
    expect(retryOutcome).toBe('resolved')
    expect(await cluster.watched.coordinator.getAllocation(INDEX)).toBeNull()
    expect(cluster.watched.liveChunks.size).toBe(0)

    const documents = await createAndFill(cluster, 'node-c', 301, SECOND_RULES)
    await expectEveryProbe(dfsSearchOver(cluster.node('router')), createOracle(documents, SECOND_RULES), 'after retry')
  }, 150_000)
})
