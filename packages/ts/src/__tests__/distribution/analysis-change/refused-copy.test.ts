import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { IndexMetadataEvent } from '../../../distribution/coordinator/types/index-metadata'
import { createInMemoryTransport } from '../../../distribution/transport'
import { type GarageCluster, startGarageCluster, waitForPrimaries } from '../../e2e/synonyms/cluster-harness'
import { INDEX } from '../../e2e/synonyms/corpus'
import {
  ChangeOracle,
  DASHES_SETTINGS,
  DASHES_TOKENIZER,
  PLAIN_LANGUAGE,
  PROBES,
  registerFixtures,
  seededRandom,
  sentence,
} from '../../engine/analysis-change/oracle'
import { waitFor } from '../../server/helpers'

const SOURCE = 'node-a'
const JOINER = 'node-c'
const DOCUMENTS = 400
const SHORT_LOG_BYTES = 4_096
const RESULT_LIMIT = 10_000
const SOURCE_BEHIND_MS = 4_000
const REFUSAL_TEXT = 'holds terms from other analysis settings'
const SETTLE_TIMEOUT_MS = 30_000

interface HeldWatch {
  readonly coordinator: ClusterCoordinator
  hold(): void
  release(): void
}

function heldWatch(inner: ClusterCoordinator): HeldWatch {
  const queued: Array<() => void> = []
  let holding = false
  return {
    coordinator: new Proxy(inner, {
      get(target, property, receiver) {
        if (property === 'watchIndexMetadata') {
          return (handler: (event: IndexMetadataEvent) => void) =>
            target.watchIndexMetadata(event => {
              if (holding) queued.push(() => handler(event))
              else handler(event)
            })
        }
        const value: unknown = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }),
    hold() {
      holding = true
    },
    release() {
      holding = false
      for (const deliver of queued.splice(0)) deliver()
    },
  }
}

const clusters: GarageCluster[] = []

beforeAll(() => {
  registerFixtures()
})

afterEach(async () => {
  for (const cluster of clusters.splice(0)) await cluster.shutdown()
})

describe('a partition copy that a node refuses during an analysis change', () => {
  it('keeps the node out of the in-sync set, keeps the primary, and loses no document', async () => {
    const cluster = await startGarageCluster([])
    clusters.push(cluster)
    const coordinator = cluster.watched.coordinator
    const refusals: string[] = []
    const startData = async (nodeId: string, nodeCoordinator: ClusterCoordinator) => {
      const transport = createInMemoryTransport(nodeId, cluster.network)
      const node = await createClusterNode({
        coordinator: nodeCoordinator,
        transport,
        address: `${nodeId}:9200`,
        nodeId,
        roles: ['data', 'coordinator'],
        replication: { logRetentionBytes: SHORT_LOG_BYTES },
        engine: { workers: { enabled: false } },
        onError(error) {
          if (error.message.includes(REFUSAL_TEXT)) refusals.push(nodeId)
        },
      })
      await node.start()
      cluster.nodes.set(nodeId, node)
      cluster.transports.set(nodeId, transport)
    }
    await cluster.startNode('controller', ['controller', 'coordinator'])
    const source = heldWatch(coordinator)
    await startData(SOURCE, source.coordinator)

    const oracle = new ChangeOracle()
    const random = seededRandom(5)
    const batch = []
    for (let i = 0; i < DOCUMENTS; i++) {
      const title = sentence(random)
      oracle.write(`doc-${i}`, title)
      batch.push({ id: `doc-${i}`, title })
    }
    await cluster
      .node(SOURCE)
      .createIndex(
        INDEX,
        { schema: { title: 'string' }, language: PLAIN_LANGUAGE },
        { partitionCount: 2, replicationFactor: 1 },
      )
    await waitForPrimaries(cluster, 1)
    expect((await cluster.node(SOURCE).insertBatch(INDEX, batch)).failed).toEqual([])

    source.hold()
    await cluster.node('controller').changeAnalysis(INDEX, { tokenizer: DASHES_TOKENIZER })
    await startData(JOINER, coordinator)
    const behindUntil = Date.now() + SOURCE_BEHIND_MS
    while (Date.now() < behindUntil) {
      const table = await coordinator.getAllocation(INDEX)
      for (const assignment of table?.assignments.values() ?? []) {
        expect(assignment.primary).toBe(SOURCE)
        expect(assignment.inSyncSet).not.toContain(JOINER)
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(refusals).toContain(JOINER)

    source.release()
    await waitFor(async () => {
      const table = await coordinator.getAllocation(INDEX)
      const assignments = [...(table?.assignments.values() ?? [])]
      return assignments.every(
        each => each.replicas.length > 0 && each.replicas.every(id => each.inSyncSet.includes(id)),
      )
    }, SETTLE_TIMEOUT_MS)
    for (const nodeId of [SOURCE, JOINER]) {
      for (const probe of PROBES) {
        const page = await cluster.node(nodeId).query(INDEX, { term: probe, limit: RESULT_LIMIT })
        expect({ nodeId, probe, hits: page.hits.map(hit => hit.id).sort() }).toEqual({
          nodeId,
          probe,
          hits: oracle.matches(probe, DASHES_SETTINGS),
        })
      }
    }
  }, 60_000)
})
