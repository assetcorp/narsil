import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator/in-memory'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'
import { NarsilError } from '../../../errors'

const INDEX_NAME = 'botanical-survey'
const FIRST_PARTITION_COUNT = 3
const SEEDED_PLOTS = 400
const WRITER_KEYS = 150
const SETTLE_WAIT_MS = 30_000
const REFUSED_BEFORE_THE_WRITE = new Set(['PARTITION_REBALANCING_BACKPRESSURE', 'PARTITION_NOT_PRIMARY'])

interface Plot {
  title: string
  rainfall: number
}

function plotTitle(sequence: number): string {
  return `meadow plot ${sequence} with sedge`
}

function hiddenNames(names: string[]): string[] {
  return names.filter(name => name.startsWith('narsil-generation-'))
}

describe('changing the partition count of a cluster index', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  const running: ClusterNode[] = []

  async function start(nodeId: string): Promise<ClusterNode> {
    const node = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport(nodeId, network),
      address: nodeId,
      nodeId,
      roles: ['data', 'coordinator', 'controller'],
      controller: { nodeLeftDelayMs: 0 },
      engine: { workers: { enabled: false } },
    })
    running.push(node)
    await node.start()
    return node
  }

  async function seededCluster(oracle: Map<string, Plot>): Promise<ClusterNode> {
    const router = await start('station-a')
    await start('station-b')
    await start('station-c')
    await router.createIndex(
      INDEX_NAME,
      { schema: { title: 'string', rainfall: 'number' } },
      { partitionCount: FIRST_PARTITION_COUNT, replicationFactor: 1 },
    )
    const plots = Array.from({ length: SEEDED_PLOTS }, (_, sequence) => ({
      id: `plot-${sequence}`,
      title: plotTitle(sequence),
      rainfall: sequence,
    }))
    expect((await router.insertBatch(INDEX_NAME, plots)).failed).toEqual([])
    for (const plot of plots) oracle.set(plot.id, { title: plot.title, rainfall: plot.rainfall })
    return router
  }

  async function writeUntilStopped(router: ClusterNode, oracle: Map<string, Plot>, stop: { done: boolean }) {
    let sequence = 0
    let refusals = 0
    while (!stop.done) {
      await new Promise(resolve => setImmediate(resolve))
      const id = `plot-${sequence % WRITER_KEYS}`
      const plot = { title: plotTitle(SEEDED_PLOTS + sequence), rainfall: SEEDED_PLOTS + sequence }
      try {
        if (sequence % 5 === 4 && oracle.has(id)) {
          await router.remove(INDEX_NAME, id)
          oracle.delete(id)
        } else if (oracle.has(id)) {
          await router.update(INDEX_NAME, id, plot)
          oracle.set(id, plot)
        } else {
          await router.insert(INDEX_NAME, plot, id)
          oracle.set(id, plot)
        }
        sequence += 1
      } catch (error) {
        if (!(error instanceof NarsilError) || !REFUSED_BEFORE_THE_WRITE.has(error.code)) throw error
        refusals += 1
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
    return { writes: sequence, refusals }
  }

  async function expectMatchesOracle(router: ClusterNode, oracle: Map<string, Plot>, partitionCount: number) {
    const table = await router.cluster.getAllocation(INDEX_NAME)
    expect(table?.assignments.size).toBe(partitionCount)
    expect(await router.countDocuments(INDEX_NAME)).toBe(oracle.size)
    const stored = await router.getMultiple(INDEX_NAME, [...oracle.keys(), 'plot-never-written'])
    expect(stored.size).toBe(oracle.size)
    for (const [id, plot] of oracle) {
      expect(stored.get(id)).toMatchObject(plot)
    }
    const listedIds: string[] = []
    let cursor: string | undefined
    do {
      const page = await router.listDocuments(INDEX_NAME, {
        limit: 200,
        document: false,
        ...(cursor === undefined ? {} : { cursor }),
      })
      listedIds.push(...page.documents.map(listed => listed.id))
      cursor = page.cursor ?? undefined
    } while (cursor !== undefined)
    expect(listedIds.sort()).toEqual([...oracle.keys()].sort())
    const found = await router.query(INDEX_NAME, { term: 'sedge', limit: 1_000 })
    expect(found.hits.map(hit => hit.id).sort()).toEqual([...oracle.keys()].sort())
  }

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
  })

  afterEach(async () => {
    for (const node of running.splice(0).reverse()) await node.shutdown().catch(() => {})
    await coordinator.shutdown()
  })

  it('keeps every acknowledged write while writers run through the copy and the cutover', async () => {
    const oracle = new Map<string, Plot>()
    const router = await seededCluster(oracle)
    const writer = running[1]
    const stop = { done: false }
    const writing = writeUntilStopped(writer, oracle, stop)

    try {
      await router.rebalance(INDEX_NAME, 7)
    } finally {
      stop.done = true
    }
    const written = await writing

    expect(written.writes).toBeGreaterThan(0)
    await expectMatchesOracle(router, oracle, 7)
    await expectMatchesOracle(writer, oracle, 7)
  }, 60_000)

  it('changes the count a second time and drops the layout that the first change built', async () => {
    const oracle = new Map<string, Plot>()
    const router = await seededCluster(oracle)

    await router.rebalance(INDEX_NAME, 6)
    const firstLayout = (await coordinator.getAllocation(INDEX_NAME))?.generation
    await router.rebalance(INDEX_NAME, 2)

    await expectMatchesOracle(router, oracle, 2)
    const deadline = Date.now() + SETTLE_WAIT_MS
    while (Date.now() < deadline && (await coordinator.listSchemas()).includes(firstLayout ?? '')) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(firstLayout).toBeDefined()
    expect(hiddenNames(await coordinator.listSchemas())).toEqual([
      (await coordinator.getAllocation(INDEX_NAME))?.generation,
    ])
    expect((await router.listIndexes()).map(index => [index.name, index.partitionCount])).toEqual([[INDEX_NAME, 2]])
  }, 60_000)

  it('refuses a count equal to the current one, a count out of range, and an index it does not hold', async () => {
    const router = await seededCluster(new Map())

    await expect(router.rebalance(INDEX_NAME, FIRST_PARTITION_COUNT)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await expect(router.rebalance(INDEX_NAME, 0)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await expect(router.rebalance(INDEX_NAME, 65_537)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await expect(router.rebalance(INDEX_NAME, 2.5)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await expect(router.rebalance('absent-survey', 4)).rejects.toMatchObject({ code: 'INDEX_NOT_FOUND' })
  }, 60_000)

  it('refuses a second change of the same index while the first one runs', async () => {
    const router = await seededCluster(new Map())

    const first = router.rebalance(INDEX_NAME, 5)
    await expect(router.rebalance(INDEX_NAME, 4)).rejects.toMatchObject({ code: 'PARTITION_REBALANCING_BACKPRESSURE' })
    await first
  }, 60_000)

  it('refuses every reserved layout name, whether a caller creates, writes to, or changes it', async () => {
    const router = await seededCluster(new Map())
    await router.rebalance(INDEX_NAME, 4)
    const hidden = (await coordinator.getAllocation(INDEX_NAME))?.generation ?? 'narsil-generation-x'

    await expect(router.createIndex('narsil-generation-own', { schema: { title: 'string' } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    })
    await expect(router.insert(hidden, { title: 'stray', rainfall: 1 })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    })
    await expect(router.rebalance(hidden, 3)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await expect(router.dropIndex(hidden)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  }, 60_000)

  it('drops a changed index with its hidden layout, so the name can be created again', async () => {
    const router = await seededCluster(new Map())
    await router.rebalance(INDEX_NAME, 4)

    await router.dropIndex(INDEX_NAME)

    const deadline = Date.now() + SETTLE_WAIT_MS
    while (Date.now() < deadline && hiddenNames(await coordinator.listSchemas()).length > 0) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(await coordinator.listSchemas()).toEqual([])
    await router.createIndex(INDEX_NAME, { schema: { title: 'string', rainfall: 'number' } }, { partitionCount: 2 })
    await router.insert(INDEX_NAME, { title: plotTitle(1), rainfall: 1 }, 'plot-1')
    expect(await router.countDocuments(INDEX_NAME)).toBe(1)
  }, 60_000)
})
