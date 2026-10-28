import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterControllerConfig, ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport, type InMemoryNetwork } from '../../../distribution/transport'

const INDEX_NAME = 'lighthouses'
const PARTITION_COUNT = 6
const DATA_NODES = ['keeper-a', 'keeper-b', 'keeper-c', 'keeper-d']
const LEAVING_NODE = 'keeper-c'
const QUIET_WAIT_MS = 2_000
const SHORT_DELAY_MS = 1_500
const ALLOCATION_WAIT_MS = 20_000

type Lighthouse = { id: string; title: string }

function lighthouses(from: number, to: number): Lighthouse[] {
  return Array.from({ length: to - from }, (_, offset) => ({
    id: `light-${from + offset}`,
    title: `granite beacon ${from + offset}`,
  }))
}

function holdersOf(table: AllocationTable): Map<number, string[]> {
  const holders = new Map<number, string[]>()
  for (const [partitionId, assignment] of table.assignments) {
    const nodes = assignment.primary === null ? [] : [assignment.primary]
    holders.set(partitionId, [...nodes, ...assignment.replicas].sort())
  }
  return holders
}

function fullyInSync(table: AllocationTable): boolean {
  return [...table.assignments.values()].every(
    entry =>
      entry.state === 'ACTIVE' &&
      entry.primary !== null &&
      entry.replicas.length === 1 &&
      entry.replicas.every(replica => entry.inSyncSet.includes(replica)),
  )
}

describe('a data node that leaves the cluster', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let root: string
  const running = new Map<string, ClusterNode>()
  let router: ClusterNode

  async function startDataNode(nodeId: string): Promise<ClusterNode> {
    const node = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport(nodeId, network),
      address: `${nodeId}:9200`,
      nodeId,
      roles: ['data'],
      engine: { durability: { directory: join(root, nodeId) } },
    })
    running.set(nodeId, node)
    await node.start()
    return node
  }

  async function startCluster(controller: ClusterControllerConfig): Promise<void> {
    for (const nodeId of DATA_NODES) await startDataNode(nodeId)
    router = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport('router', network),
      address: 'router:9200',
      nodeId: 'router',
      roles: ['coordinator', 'controller'],
      controller,
    })
    running.set('router', router)
    await router.start()
    await router.createIndex(
      INDEX_NAME,
      { schema: { title: 'string' } },
      { partitionCount: PARTITION_COUNT, replicationFactor: 1 },
    )
    await waitForAllocation(fullyInSync)
    expect((await router.insertBatch(INDEX_NAME, lighthouses(0, 60))).failed).toEqual([])
  }

  async function stopNode(nodeId: string): Promise<void> {
    const node = running.get(nodeId)
    running.delete(nodeId)
    await node?.shutdown()
  }

  async function waitForAllocation(settled: (table: AllocationTable) => boolean): Promise<AllocationTable> {
    const deadline = Date.now() + ALLOCATION_WAIT_MS
    let last: AllocationTable | null = null
    while (Date.now() < deadline) {
      last = await coordinator.getAllocation(INDEX_NAME)
      if (last !== null && settled(last)) return last
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`the allocation never settled; last seen ${JSON.stringify([...(last?.assignments ?? [])])}`)
  }

  async function expectEveryLighthouse(total: number): Promise<void> {
    const expected = lighthouses(0, total)
    const read = await router.getMultiple(
      INDEX_NAME,
      expected.map(light => light.id),
    )
    expect(new Map([...read].map(([id, document]) => [id, document.title]))).toEqual(
      new Map(expected.map(light => [light.id, light.title])),
    )
    const answer = await router.query(INDEX_NAME, { term: 'beacon', limit: total + 10 })
    expect(answer.coverage.queriedPartitions).toBe(PARTITION_COUNT)
    expect(answer.hits.map(hit => hit.id).sort()).toEqual(expected.map(light => light.id).sort())
  }

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    root = await mkdtemp(join(tmpdir(), 'narsil-node-left-delay-'))
  })

  afterEach(async () => {
    for (const nodeId of [...running.keys()]) await stopNode(nodeId).catch(() => {})
    await coordinator.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('keeps its replicas in place while it is away, and takes them back when it returns', async () => {
    await startCluster({})
    const before = holdersOf(await waitForAllocation(fullyInSync))
    const ledByLeaver = [...(await waitForAllocation(fullyInSync)).assignments]
      .filter(([, entry]) => entry.primary === LEAVING_NODE)
      .map(([partitionId]) => partitionId)

    await stopNode(LEAVING_NODE)
    const promoted = await waitForAllocation(table =>
      ledByLeaver.every(partitionId => table.assignments.get(partitionId)?.primary !== LEAVING_NODE),
    )
    for (const partitionId of ledByLeaver) {
      expect(promoted.assignments.get(partitionId)?.state).toBe('ACTIVE')
    }
    expect((await router.insertBatch(INDEX_NAME, lighthouses(60, 90))).failed).toEqual([])

    await new Promise(resolve => setTimeout(resolve, QUIET_WAIT_MS))
    const whileAway = await waitForAllocation(() => true)
    expect(holdersOf(whileAway)).toEqual(before)
    for (const entry of whileAway.assignments.values()) {
      expect(entry.inSyncSet).not.toContain(LEAVING_NODE)
      expect(entry.primary).not.toBe(LEAVING_NODE)
    }

    await startDataNode(LEAVING_NODE)
    const returned = await waitForAllocation(fullyInSync)
    expect(holdersOf(returned)).toEqual(before)
    await expectEveryLighthouse(90)
  }, 60_000)

  it('moves its replicas to the other nodes once the delay runs out', async () => {
    await startCluster({ nodeLeftDelayMs: SHORT_DELAY_MS })

    await stopNode(LEAVING_NODE)
    const moved = await waitForAllocation(
      table => fullyInSync(table) && [...holdersOf(table).values()].every(nodes => !nodes.includes(LEAVING_NODE)),
    )
    for (const nodes of holdersOf(moved).values()) expect(new Set(nodes).size).toBe(2)
    await expectEveryLighthouse(60)
  }, 60_000)
})
