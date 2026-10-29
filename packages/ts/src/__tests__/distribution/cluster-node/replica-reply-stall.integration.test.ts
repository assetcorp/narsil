import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'
import type { NodeTransport, RespondFn, TransportMessage } from '../../../distribution/transport/types'

const INDEX_NAME = 'tide-gauges'
const PARTITION_COUNT = 6
const DATA_NODES = ['keeper-a', 'keeper-b', 'keeper-c', 'keeper-d']
const STALLED_NODE = 'keeper-c'
const REPLICATION_TIMEOUT_MS = 1_500
const ALLOCATOR_TICK_MS = 1_000
const SCHEDULING_SLACK_MS = 1_000
const ALLOCATION_WAIT_MS = 30_000
const STALLED_WRITES = 6
const REPLY_TYPES = new Set(['replication.entry', 'replication.entry_batch'])
const ADMISSION_TYPE = 'replication.insync_add'

type Gauge = { id: string; station: string }

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193)
  }
  return hash >>> 0
}

function gaugesOnPartition(partitionId: number, prefix: string, count: number): Gauge[] {
  const gauges: Gauge[] = []
  for (let n = 0; gauges.length < count; n++) {
    const id = `${prefix}-${n}`
    if (fnv1a(id) % PARTITION_COUNT === partitionId) gauges.push({ id, station: `harbour station ${id}` })
  }
  return gauges
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

function replicatedBy(table: AllocationTable, replicaNodeId: string): [number, PartitionAssignment] {
  for (const [partitionId, assignment] of table.assignments) {
    if (assignment.replicas.includes(replicaNodeId) && assignment.inSyncSet.includes(replicaNodeId)) {
      return [partitionId, assignment]
    }
  }
  throw new Error(`${replicaNodeId} replicates no partition in ${JSON.stringify([...table.assignments])}`)
}

describe('a replica that stops answering replication entries', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let root: string
  const running = new Map<string, ClusterNode>()
  let router: ClusterNode
  const stall = { active: false, held: [] as (() => Promise<void>)[], admissionsRefused: false }

  function stallableTransport(nodeId: string): NodeTransport {
    const inner = createInMemoryTransport(nodeId, network, { replicationTimeout: REPLICATION_TIMEOUT_MS })
    return {
      ...inner,
      listen: handler =>
        inner.listen((message: TransportMessage, respond: RespondFn) => {
          if (!REPLY_TYPES.has(message.type)) return handler(message, respond)
          return handler(message, async reply => {
            if (stall.active) stall.held.push(() => respond(reply))
            else await respond(reply)
          })
        }),
    }
  }

  function controllerTransport(): NodeTransport {
    const inner = createInMemoryTransport('router', network, { replicationTimeout: REPLICATION_TIMEOUT_MS })
    return {
      ...inner,
      listen: handler =>
        inner.listen((message: TransportMessage, respond: RespondFn) => {
          if (stall.admissionsRefused && message.type === ADMISSION_TYPE) return
          return handler(message, respond)
        }),
    }
  }

  async function startDataNode(nodeId: string): Promise<ClusterNode> {
    const node = await createClusterNode({
      coordinator,
      transport:
        nodeId === STALLED_NODE
          ? stallableTransport(nodeId)
          : createInMemoryTransport(nodeId, network, { replicationTimeout: REPLICATION_TIMEOUT_MS }),
      address: `${nodeId}:9200`,
      nodeId,
      roles: ['data'],
      engine: { workers: { enabled: false }, durability: { directory: join(root, nodeId) } },
    })
    running.set(nodeId, node)
    await node.start()
    return node
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

  async function expectGauges(acknowledged: Map<string, string>): Promise<void> {
    const read = await router.getMultiple(INDEX_NAME, [...acknowledged.keys()])
    expect(new Map([...read].map(([id, document]) => [id, document.station]))).toEqual(acknowledged)
  }

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    root = await mkdtemp(join(tmpdir(), 'narsil-reply-stall-'))
    stall.active = false
    stall.held = []
    stall.admissionsRefused = false
    for (const nodeId of DATA_NODES) await startDataNode(nodeId)
    router = await createClusterNode({
      coordinator,
      transport: controllerTransport(),
      address: 'router:9200',
      nodeId: 'router',
      roles: ['coordinator', 'controller'],
    })
    running.set('router', router)
    await router.start()
    await router.createIndex(
      INDEX_NAME,
      { schema: { station: 'string' } },
      { partitionCount: PARTITION_COUNT, replicationFactor: 1 },
    )
    await waitForAllocation(fullyInSync)
  })

  afterEach(async () => {
    stall.active = false
    stall.admissionsRefused = false
    for (const release of stall.held.splice(0)) await release().catch(() => {})
    for (const nodeId of [...running.keys()]) await stopNode(nodeId).catch(() => {})
    await coordinator.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('drops it from the in-sync set within the replication timeout, keeps writing, and takes it back once it answers', async () => {
    const acknowledged = new Map<string, string>()
    const [partitionId, assignment] = replicatedBy(await waitForAllocation(fullyInSync), STALLED_NODE)
    const primary = assignment.primary
    if (primary === null) throw new Error(`partition ${partitionId} has no primary`)

    const before = gaugesOnPartition(partitionId, 'before', 10)
    expect((await router.insertBatch(INDEX_NAME, before)).failed).toEqual([])
    for (const gauge of before) acknowledged.set(gauge.id, gauge.station)

    stall.active = true
    const stalled = gaugesOnPartition(partitionId, 'stalled', STALLED_WRITES)
    const latencies = await Promise.all(
      stalled.map(async gauge => {
        const started = Date.now()
        await router.insert(INDEX_NAME, gauge)
        acknowledged.set(gauge.id, gauge.station)
        return Date.now() - started
      }),
    )
    expect(Math.max(...latencies)).toBeLessThan(REPLICATION_TIMEOUT_MS + ALLOCATOR_TICK_MS + SCHEDULING_SLACK_MS)

    const dropped = (await coordinator.getAllocation(INDEX_NAME))?.assignments.get(partitionId)
    expect(dropped?.primary).toBe(primary)
    expect(dropped?.replicas).toEqual([STALLED_NODE])
    expect(dropped?.inSyncSet).not.toContain(STALLED_NODE)

    const whileOut = gaugesOnPartition(partitionId, 'while-out', 10)
    const outStarted = Date.now()
    expect((await router.insertBatch(INDEX_NAME, whileOut)).failed).toEqual([])
    expect(Date.now() - outStarted).toBeLessThan(REPLICATION_TIMEOUT_MS)
    for (const gauge of whileOut) acknowledged.set(gauge.id, gauge.station)

    stall.active = false
    for (const release of stall.held.splice(0)) await release().catch(() => {})
    await waitForAllocation(fullyInSync)

    const after = gaugesOnPartition(partitionId, 'after', 10)
    expect((await router.insertBatch(INDEX_NAME, after)).failed).toEqual([])
    for (const gauge of after) acknowledged.set(gauge.id, gauge.station)
    await expectGauges(acknowledged)

    await stopNode(primary)
    const promoted = await waitForAllocation(table => table.assignments.get(partitionId)?.primary === STALLED_NODE)
    expect(promoted.assignments.get(partitionId)?.state).toBe('ACTIVE')
    await expectGauges(acknowledged)
    const answer = await router.query(INDEX_NAME, { term: 'harbour', limit: acknowledged.size + 10 })
    expect(answer.hits.map(hit => hit.id).sort()).toEqual([...acknowledged.keys()].sort())
  }, 90_000)

  it('lets the primary shut down while a catch-up batch to it waits for a reply', async () => {
    const [partitionId, assignment] = replicatedBy(await waitForAllocation(fullyInSync), STALLED_NODE)
    const primary = assignment.primary
    if (primary === null) throw new Error(`partition ${partitionId} has no primary`)

    stall.active = true
    stall.admissionsRefused = true
    expect((await router.insertBatch(INDEX_NAME, gaugesOnPartition(partitionId, 'stalled', 4))).failed).toEqual([])
    await waitForAllocation(table => !table.assignments.get(partitionId)?.inSyncSet.includes(STALLED_NODE))
    await new Promise(resolve => setTimeout(resolve, 2 * ALLOCATOR_TICK_MS))
    expect((await router.insertBatch(INDEX_NAME, gaugesOnPartition(partitionId, 'behind', 20))).failed).toEqual([])

    const heldBefore = stall.held.length
    const deadline = Date.now() + ALLOCATION_WAIT_MS
    const trickle = gaugesOnPartition(partitionId, 'trickle', 200)
    while (stall.held.length === heldBefore && Date.now() < deadline) {
      const gauge = trickle.shift()
      if (gauge !== undefined) await router.insert(INDEX_NAME, gauge)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(stall.held.length).toBeGreaterThan(heldBefore)

    const started = Date.now()
    await stopNode(primary)
    expect(Date.now() - started).toBeLessThan(REPLICATION_TIMEOUT_MS)
  }, 90_000)
})
