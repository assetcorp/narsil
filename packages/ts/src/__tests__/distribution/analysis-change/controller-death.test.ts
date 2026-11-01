import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { indexConfigKey, readIndexMetadataSnapshot } from '../../../distribution/cluster/index-metadata'
import { CONTROLLER_LEASE_KEY } from '../../../distribution/coordinator/constants'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { type GarageCluster, startGarageCluster, waitForPrimaries } from '../../e2e/synonyms/cluster-harness'
import { INDEX } from '../../e2e/synonyms/corpus'
import {
  ChangeOracle,
  DASHES_SETTINGS,
  DASHES_TOKENIZER,
  OLD_SETTINGS,
  PLAIN_LANGUAGE,
  PROBES,
  registerFixtures,
  seededRandom,
  sentence,
} from '../../engine/analysis-change/oracle'
import { waitFor } from '../../server/helpers'

const DOOMED_CONTROLLER = 'controller-a'
const STANDBYS = ['node-b', 'node-c']
const DOCUMENTS = 3_000
const RESULT_LIMIT = 10_000
const LEASE_HANDOVER_TIMEOUT_MS = 60_000
const SEARCH_PAUSE_MS = 50

interface SeveredCoordinator {
  readonly coordinator: ClusterCoordinator
  killOnNextIndexWrite: boolean
  dead: boolean
}

function severable(inner: ClusterCoordinator): SeveredCoordinator {
  const lost = () => Promise.reject(new Error('the connection to the coordinator is gone'))
  const state: SeveredCoordinator = {
    killOnNextIndexWrite: false,
    dead: false,
    coordinator: new Proxy(inner, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          if (state.dead) return lost()
          if (state.killOnNextIndexWrite && property === 'compareAndSet' && args[0] === indexConfigKey(INDEX)) {
            state.dead = true
            return lost()
          }
          return value.apply(target, args)
        }
      },
    }),
  }
  return state
}

const clusters: GarageCluster[] = []
const severed: SeveredCoordinator[] = []

beforeAll(() => {
  registerFixtures()
})

afterEach(async () => {
  for (const each of severed.splice(0)) each.dead = false
  for (const cluster of clusters.splice(0)) await cluster.shutdown()
})

async function hitsOf(cluster: GarageCluster, nodeId: string, term: string): Promise<string[]> {
  const page = await cluster.node(nodeId).query(INDEX, { term, limit: RESULT_LIMIT })
  return page.hits.map(hit => hit.id).sort()
}

describe('the controller dying during an analysis change', () => {
  it('lets a standby publish the change, while every search answers under one set of settings', async () => {
    const cluster = await startGarageCluster([])
    clusters.push(cluster)
    const coordinator = cluster.watched.coordinator
    const doomed = severable(coordinator)
    severed.push(doomed)
    await cluster.startNode(DOOMED_CONTROLLER, ['controller', 'coordinator'], undefined, doomed.coordinator)
    await waitFor(async () => (await coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)) === DOOMED_CONTROLLER)
    for (const nodeId of STANDBYS) await cluster.startNode(nodeId, ['data', 'coordinator', 'controller'])

    const oracle = new ChangeOracle()
    const random = seededRandom(83)
    const batch = []
    for (let i = 0; i < DOCUMENTS; i++) {
      const title = sentence(random)
      oracle.write(`doc-${i}`, title)
      batch.push({ id: `doc-${i}`, title })
    }
    const [asker, reader] = STANDBYS
    await cluster
      .node(asker)
      .createIndex(
        INDEX,
        { schema: { title: 'string' }, language: PLAIN_LANGUAGE },
        { partitionCount: 3, replicationFactor: 1 },
      )
    await waitForPrimaries(cluster, STANDBYS.length)
    expect((await cluster.node(asker).insertBatch(INDEX, batch)).failed).toEqual([])
    await waitFor(async () => {
      const table = await coordinator.getAllocation(INDEX)
      const assignments = [...(table?.assignments.values() ?? [])]
      return assignments.every(each => each.replicas.every(replica => each.inSyncSet.includes(replica)))
    })

    const oldAnswer = oracle.matches('sea', OLD_SETTINGS)
    const newAnswer = oracle.matches('sea', DASHES_SETTINGS)
    expect(oldAnswer).not.toEqual(newAnswer)

    doomed.killOnNextIndexWrite = true
    let finished = false
    const change = cluster
      .node(asker)
      .changeAnalysis(INDEX, { tokenizer: DASHES_TOKENIZER })
      .finally(() => {
        finished = true
      })
    while (!finished) {
      const hits = await hitsOf(cluster, reader, 'sea')
      expect([oldAnswer, newAnswer]).toContainEqual(hits)
      await new Promise(resolve => setTimeout(resolve, SEARCH_PAUSE_MS))
    }
    await change

    expect(doomed.dead).toBe(true)
    await waitFor(async () => {
      const holder = await coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
      return holder !== null && holder !== DOOMED_CONTROLLER
    }, LEASE_HANDOVER_TIMEOUT_MS)
    const snapshot = await readIndexMetadataSnapshot(coordinator, INDEX)
    expect(snapshot?.settings?.analysisGeneration).toBe(1)
    expect(snapshot?.settings?.pendingAnalysis).toBeUndefined()
    for (const nodeId of STANDBYS) {
      for (const probe of PROBES) {
        expect({ nodeId, probe, hits: await hitsOf(cluster, nodeId, probe) }).toEqual({
          nodeId,
          probe,
          hits: oracle.matches(probe, DASHES_SETTINGS),
        })
      }
    }
  }, 120_000)
})
