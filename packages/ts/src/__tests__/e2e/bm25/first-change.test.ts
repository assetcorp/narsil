import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { IndexMetadataEvent } from '../../../distribution/coordinator/types/index-metadata'
import type { BM25Params } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import { waitFor } from '../../server/helpers'
import { type GarageCluster, PARTITION_COUNT, startGarageCluster, waitForPrimaries } from '../synonyms/cluster-harness'
import { INDEX, LANGUAGE_NAME, registerGarageLanguage, SCHEMA } from '../synonyms/corpus'
import { bm25Corpus, differsFromOracle, expectOracleScores, FULL_LIMIT, searchWith, TITLE_HEAVY } from './harness'
import { createBm25Oracle } from './oracle'

const WRITER = 'node-a'
const UNAPPLIED_COPY = 'node-b'
const LATE_COORDINATOR = 'node-c'
const DFS: Partial<QueryParams> = { scoring: 'dfs' }
const PROBE = { term: 'stone film road', limit: FULL_LIMIT }

const clusters: GarageCluster[] = []

beforeAll(() => {
  registerGarageLanguage()
})

afterEach(async () => {
  for (const cluster of clusters.splice(0)) await cluster.shutdown()
})

interface HeldBackWatch {
  coordinator: ClusterCoordinator
  holdBack(): void
  release(): void
}

function heldBackWatch(inner: ClusterCoordinator): HeldBackWatch {
  const backlog: Array<() => void> = []
  let holding = false
  const coordinator = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'watchIndexMetadata') {
        return (handler: (event: IndexMetadataEvent) => void) =>
          target.watchIndexMetadata(event => {
            if (holding) backlog.push(() => handler(event))
            else handler(event)
          })
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    coordinator,
    holdBack() {
      holding = true
    },
    release() {
      holding = false
      for (const deliver of backlog.splice(0)) deliver()
    },
  }
}

describe.each([
  { label: 'an index with no setting', first: undefined as BM25Params | undefined },
  { label: 'an index created with a pair', first: { k1: 2, b: 0.3 } as BM25Params | undefined },
])('a coordinator that has not received the first change of $label', ({ first }) => {
  it('scores every copy under the creation value, whichever copies have applied the change', async () => {
    const documents = bm25Corpus(1_500, 961)
    const oracle = createBm25Oracle(documents)
    const cluster = await startGarageCluster([])
    clusters.push(cluster)
    const unapplied = heldBackWatch(cluster.watched.coordinator)
    const late = heldBackWatch(cluster.watched.coordinator)
    await cluster.startNode(WRITER, ['data', 'coordinator', 'controller'])
    await cluster.startNode(UNAPPLIED_COPY, ['data', 'coordinator'], undefined, unapplied.coordinator)
    await cluster.startNode(LATE_COORDINATOR, ['data', 'coordinator'], undefined, late.coordinator)
    await cluster
      .node(WRITER)
      .createIndex(
        INDEX,
        { schema: SCHEMA, language: LANGUAGE_NAME, ...(first !== undefined ? { bm25: first } : {}) },
        { partitionCount: PARTITION_COUNT, replicationFactor: 0 },
      )
    await waitForPrimaries(cluster, 3)
    expect((await cluster.node(WRITER).insertBatch(INDEX, documents)).failed).toEqual([])

    const lateSearch = searchWith(cluster.node(LATE_COORDINATOR), DFS)
    const unappliedSearch = searchWith(cluster.node(UNAPPLIED_COPY), DFS)
    await expectOracleScores(lateSearch, oracle, first, undefined, 'before the change')
    await expectOracleScores(unappliedSearch, oracle, first, undefined, 'the other coordinator before the change')

    late.holdBack()
    unapplied.holdBack()
    await cluster.node(WRITER).updateBM25(INDEX, TITLE_HEAVY)
    await expectOracleScores(searchWith(cluster.node(WRITER), DFS), oracle, TITLE_HEAVY, undefined, 'the writer')
    await expectOracleScores(lateSearch, oracle, first, undefined, 'one copy has applied the change')

    unapplied.release()
    await waitFor(
      async () => differsFromOracle(await unappliedSearch(PROBE, undefined), oracle, PROBE, TITLE_HEAVY) === null,
    )
    await expectOracleScores(lateSearch, oracle, first, undefined, 'two copies have applied the change')

    late.release()
    await waitFor(
      async () => differsFromOracle(await lateSearch(PROBE, undefined), oracle, PROBE, TITLE_HEAVY) === null,
    )
    await expectOracleScores(lateSearch, oracle, TITLE_HEAVY, undefined, 'once the change arrives')
  }, 180_000)
})
