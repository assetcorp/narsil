import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'
import type { NodeTransport } from '../../../distribution/transport/types'
import { NarsilError } from '../../../errors'
import { registerLanguage } from '../../../languages/registry'

const INDEX_NAME = 'logbook'
const LANGUAGE = 'cluster-rebuild-analysis'
const DATA_NODES = ['deck-a', 'deck-b']
const ENTRIES = Array.from({ length: 12 }, (_, index) => ({ id: `entry-${index}`, title: `jumping tide ${index}` }))
const ALLOCATION_WAIT_MS = 20_000

function stripIng(token: string): string {
  return token.endsWith('ing') ? token.slice(0, -3) : token
}

async function waitForInSync(coordinator: ClusterCoordinator): Promise<void> {
  const deadline = Date.now() + ALLOCATION_WAIT_MS
  while (Date.now() < deadline) {
    const table = await coordinator.getAllocation(INDEX_NAME)
    const ready =
      table !== null &&
      [...table.assignments.values()].every(
        entry =>
          entry.state === 'ACTIVE' &&
          entry.primary !== null &&
          entry.replicas.length === 1 &&
          entry.replicas.every(replica => entry.inSyncSet.includes(replica)),
      )
    if (ready) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the allocation never settled')
}

describe('an analysis rebuild that a cluster node receives', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  const directories = new Map<string, string>()
  const running = new Map<string, ClusterNode>()
  const transports = new Map<string, NodeTransport>()

  async function startNode(nodeId: string, roles: Array<'data' | 'coordinator' | 'controller'>): Promise<ClusterNode> {
    const directory = directories.get(nodeId)
    const transport = createInMemoryTransport(nodeId, network)
    transports.set(nodeId, transport)
    const node = await createClusterNode({
      coordinator,
      transport,
      address: nodeId,
      nodeId,
      roles,
      engine: {
        workers: { enabled: false },
        analysis: { rebuild: 'manual' },
        ...(directory === undefined ? {} : { durability: { directory } }),
      },
    })
    running.set(nodeId, node)
    await node.start()
    return node
  }

  async function stopNode(nodeId: string): Promise<void> {
    await running.get(nodeId)?.shutdown()
    await transports.get(nodeId)?.shutdown()
    running.delete(nodeId)
    transports.delete(nodeId)
  }

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    for (const nodeId of DATA_NODES) directories.set(nodeId, await mkdtemp(join(tmpdir(), `narsil-${nodeId}-`)))
  })

  afterEach(async () => {
    for (const nodeId of [...running.keys()]) await stopNode(nodeId).catch(() => {})
    await coordinator.shutdown()
    for (const directory of directories.values()) await rm(directory, { recursive: true, force: true })
    directories.clear()
  })

  it('rebuilds every copy from its own documents, so each holder answers with the new terms', async () => {
    registerLanguage({ name: LANGUAGE, revision: '1', stemmer: null, stopWords: new Set<string>() })
    for (const nodeId of DATA_NODES) await startNode(nodeId, ['data'])
    const firstRouter = await startNode('chart-desk', ['coordinator', 'controller'])
    await firstRouter.createIndex(
      INDEX_NAME,
      { schema: { title: 'string' }, language: LANGUAGE },
      { partitionCount: 4, replicationFactor: 1 },
    )
    await waitForInSync(coordinator)
    expect((await firstRouter.insertBatch(INDEX_NAME, ENTRIES)).failed).toEqual([])
    for (const nodeId of DATA_NODES) await running.get(nodeId)?.checkpoint(INDEX_NAME)
    for (const nodeId of ['chart-desk', ...DATA_NODES]) await stopNode(nodeId)

    registerLanguage({ name: LANGUAGE, revision: '2', stemmer: stripIng, stopWords: new Set<string>() })
    for (const nodeId of DATA_NODES) await startNode(nodeId, ['data'])
    const router = await startNode('chart-desk', ['coordinator', 'controller'])
    await waitForInSync(coordinator)

    const stale = await router.preflight(INDEX_NAME, { term: 'jump' })
    expect(stale.analysisStale).toBe(true)
    expect((await router.query(INDEX_NAME, { term: 'jump', limit: 50 })).hits).toHaveLength(0)

    await router.rebuildAnalysis(INDEX_NAME)

    expect((await router.preflight(INDEX_NAME, { term: 'jump' })).analysisStale).toBeUndefined()
    const rebuilt = await router.query(INDEX_NAME, { term: 'jump', limit: 50 })
    expect(rebuilt.hits.map(hit => hit.id).sort()).toEqual(ENTRIES.map(entry => entry.id).sort())

    await stopNode('deck-a')
    const fromOneHolder = await router.query(INDEX_NAME, { term: 'jump', limit: 50 })
    expect(fromOneHolder.coverage.queriedPartitions).toBe(4)
    expect(fromOneHolder.hits.map(hit => hit.id).sort()).toEqual(ENTRIES.map(entry => entry.id).sort())

    const partial = await router.rebuildAnalysis(INDEX_NAME).catch((error: unknown) => error)
    expect(partial).toBeInstanceOf(NarsilError)
    expect((partial as NarsilError).code).toBe('QUERY_PARTIAL_FAILURE')
    expect((partial as NarsilError).details).toMatchObject({ nodeIds: ['deck-a'] })
  }, 90_000)
})
