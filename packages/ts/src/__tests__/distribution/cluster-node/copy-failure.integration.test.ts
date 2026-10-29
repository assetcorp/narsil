import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { decode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { resolvePartitionId } from '../../../distribution/cluster-node/write-routing/assignment'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'
import type { NodeTransport, TransportMessage } from '../../../distribution/transport/types'
import { NarsilError } from '../../../errors'

const disk = vi.hoisted(() => ({
  failSyncUnder: null as string | null,
  failReadsUnder: null as string | null,
  syncFailures: 0,
}))

vi.mock('#platform/durable-fs', async importOriginal => {
  const original = await importOriginal<typeof import('../../../persistence/durability/node-fs')>()
  const fs = await original.getFs()
  type Handle = Awaited<ReturnType<typeof fs.open>>
  const ioError = (path: string) => Object.assign(new Error(`EIO: i/o error, '${path}'`), { code: 'EIO' })
  function failing(path: string, handle: Handle): Handle {
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'sync') {
          return async () => {
            if (disk.failSyncUnder !== null && path.startsWith(disk.failSyncUnder)) {
              disk.failSyncUnder = null
              disk.syncFailures += 1
              throw ioError(path)
            }
            return target.sync()
          }
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  const unreadable = (path: string) => disk.failReadsUnder !== null && path.startsWith(disk.failReadsUnder)
  const open = async (...args: Parameters<typeof fs.open>): Promise<Handle> => {
    const path = String(args[0])
    if (unreadable(path) && (args[1] === undefined || args[1] === 'r')) throw ioError(path)
    return failing(path, await fs.open(...args))
  }
  const readFile = async (...args: Parameters<typeof fs.readFile>) => {
    if (unreadable(String(args[0]))) throw ioError(String(args[0]))
    return fs.readFile(...args)
  }
  return { ...original, getFs: async () => ({ ...fs, open, readFile }) }
})

const INDEX_NAME = 'harbour-berths'
const PARTITION_COUNT = 2
const ALLOCATION_WAIT_MS = 30_000

type Berth = { id: string; vessel: string }

describe('a node whose copy of one partition fails', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let root: string
  const running = new Map<string, ClusterNode>()
  const reported: Error[] = []
  const syncRequests: { nodeId: string; lastSeqNo: number; lastPrimaryTerm: number }[] = []
  let router: ClusterNode
  let serial = 0

  function recordingTransport(nodeId: string): NodeTransport {
    const inner = createInMemoryTransport(nodeId, network)
    return {
      ...inner,
      stream: (target: string, message: TransportMessage, handler: (chunk: Uint8Array) => void) => {
        if (message.type === 'replication.sync_request') {
          const payload = decode(message.payload) as { partitionId: number; lastSeqNo: number; lastPrimaryTerm: number }
          if (payload.partitionId === 0) syncRequests.push({ nodeId, ...payload })
        }
        return inner.stream(target, message, handler)
      },
    }
  }

  async function startDataNode(nodeId: string): Promise<void> {
    const node = await createClusterNode({
      coordinator,
      transport: recordingTransport(nodeId),
      address: `${nodeId}:9200`,
      nodeId,
      roles: ['data'],
      engine: { workers: { enabled: false }, durability: { directory: join(root, nodeId) } },
      onError: error => reported.push(error),
    })
    running.set(nodeId, node)
    await node.start()
  }

  async function stopNode(nodeId: string): Promise<void> {
    const node = running.get(nodeId)
    running.delete(nodeId)
    await node?.shutdown()
  }

  function walOf(nodeId: string, partitionId: number): string {
    return join(root, nodeId, INDEX_NAME, 'wal', String(partitionId)) + sep
  }

  async function waitForAllocation(done: (table: AllocationTable) => boolean): Promise<AllocationTable> {
    const deadline = Date.now() + ALLOCATION_WAIT_MS
    let last: AllocationTable | null = null
    while (Date.now() < deadline) {
      last = await coordinator.getAllocation(INDEX_NAME)
      if (last !== null && done(last)) return last
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`the allocation never settled; last seen ${JSON.stringify([...(last?.assignments ?? [])])}`)
  }

  function partition(table: AllocationTable, partitionId: number): PartitionAssignment {
    const assignment = table.assignments.get(partitionId)
    if (assignment === undefined) throw new Error(`partition ${partitionId} has no assignment`)
    return assignment
  }

  function servedWith(replicas: number) {
    return (table: AllocationTable) =>
      [...table.assignments.values()].every(
        assignment =>
          assignment.state === 'ACTIVE' &&
          assignment.primary !== null &&
          assignment.replicas.length === replicas &&
          assignment.replicas.every(replica => assignment.inSyncSet.includes(replica)),
      )
  }

  function berthsIn(partitionId: number, count: number, vessel: string): Berth[] {
    const berths: Berth[] = []
    while (berths.length < count) {
      serial += 1
      const id = `berth-${serial}`
      if (resolvePartitionId(id, PARTITION_COUNT) === partitionId) berths.push({ id, vessel: `${vessel} ${serial}` })
    }
    return berths
  }

  async function insertAcknowledged(berths: Berth[], acknowledged: Map<string, string>): Promise<string[]> {
    const result = await router.insertBatch(INDEX_NAME, berths)
    for (const berth of berths) if (result.succeeded.includes(berth.id)) acknowledged.set(berth.id, berth.vessel)
    return result.failed.map(failure => failure.docId)
  }

  async function expectOracle(acknowledged: Map<string, string>): Promise<void> {
    const read = await router.getMultiple(INDEX_NAME, [...acknowledged.keys()])
    expect(new Map([...read].map(([id, document]) => [id, String(document.vessel)]))).toEqual(acknowledged)
    const answer = await router.query(INDEX_NAME, { term: 'tug', limit: 1_000 })
    expect(answer.hits.map(hit => hit.id).sort()).toEqual([...acknowledged.keys()].sort())
  }

  async function startCluster(dataNodes: string[], replicationFactor: number): Promise<AllocationTable> {
    for (const nodeId of dataNodes) await startDataNode(nodeId)
    router = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport('router', network),
      address: 'router:9200',
      nodeId: 'router',
      roles: ['coordinator', 'controller'],
    })
    running.set('router', router)
    await router.start()
    await router.createIndex(
      INDEX_NAME,
      { schema: { vessel: 'string' } },
      { partitionCount: PARTITION_COUNT, replicationFactor },
    )
    return waitForAllocation(servedWith(replicationFactor))
  }

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    root = await mkdtemp(join(tmpdir(), 'narsil-copy-failure-'))
    disk.failSyncUnder = null
    disk.failReadsUnder = null
    disk.syncFailures = 0
    reported.length = 0
    syncRequests.length = 0
  })

  afterEach(async () => {
    disk.failSyncUnder = null
    disk.failReadsUnder = null
    for (const nodeId of [...running.keys()]) await stopNode(nodeId).catch(() => {})
    await coordinator.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('rejoins as an empty copy when it is a replica, while its other partition keeps taking writes', async () => {
    const before = partition(await startCluster(['quay-a', 'quay-b'], 1), 0)
    const primary = before.primary
    const replica = before.replicas[0]
    if (primary === null || replica === undefined) throw new Error('partition 0 has no primary and replica')
    const acknowledged = new Map<string, string>()
    expect(await insertAcknowledged([...berthsIn(0, 20, 'tug'), ...berthsIn(1, 20, 'tug')], acknowledged)).toEqual([])

    const sentBefore = syncRequests.length
    disk.failSyncUnder = walOf(replica, 0)
    expect(await insertAcknowledged([...berthsIn(0, 10, 'tug'), ...berthsIn(1, 10, 'tug')], acknowledged)).toEqual([])
    expect(disk.syncFailures).toBe(1)
    for (let round = 0; round < 5; round++) {
      expect(await insertAcknowledged(berthsIn(1, 5, 'tug'), acknowledged)).toEqual([])
    }

    await waitForAllocation(table => servedWith(1)(table) && partition(table, 0).primary === primary)
    expect(syncRequests.slice(sentBefore).find(request => request.nodeId === replica)).toMatchObject({
      lastSeqNo: 0,
      lastPrimaryTerm: 0,
    })
    expect(await insertAcknowledged(berthsIn(0, 10, 'tug'), acknowledged)).toEqual([])

    await stopNode(primary)
    await waitForAllocation(table => [...table.assignments.values()].every(entry => entry.primary === replica))
    await expectOracle(acknowledged)
  }, 120_000)

  it('gives the partition to its replica when it is the primary, and keeps every acknowledged write', async () => {
    const before = partition(await startCluster(['quay-a', 'quay-b'], 1), 0)
    const primary = before.primary
    const replica = before.replicas[0]
    if (primary === null || replica === undefined) throw new Error('partition 0 has no primary and replica')
    const acknowledged = new Map<string, string>()
    expect(await insertAcknowledged([...berthsIn(0, 20, 'tug'), ...berthsIn(1, 20, 'tug')], acknowledged)).toEqual([])

    const sentBefore = syncRequests.length
    disk.failSyncUnder = walOf(primary, 0)
    const [partitionZero, partitionOne] = await Promise.all([
      insertAcknowledged(berthsIn(0, 10, 'tug'), acknowledged),
      insertAcknowledged(berthsIn(1, 10, 'tug'), acknowledged),
    ])
    expect(disk.syncFailures).toBe(1)
    expect(partitionZero).toEqual([])
    expect(partitionOne).toEqual([])

    const failedOver = await waitForAllocation(
      table =>
        servedWith(1)(table) && partition(table, 0).primary === replica && partition(table, 0).replicas[0] === primary,
    )
    expect(partition(failedOver, 0).primaryTerm).toBeGreaterThan(before.primaryTerm)
    expect(syncRequests.slice(sentBefore).find(request => request.nodeId === primary)).toMatchObject({
      lastSeqNo: 0,
      lastPrimaryTerm: 0,
    })
    expect(await insertAcknowledged([...berthsIn(0, 10, 'tug'), ...berthsIn(1, 10, 'tug')], acknowledged)).toEqual([])

    await stopNode(replica)
    await waitForAllocation(table => [...table.assignments.values()].every(entry => entry.primary === primary))
    await expectOracle(acknowledged)
  }, 120_000)

  it('serves the partition again from its own disk when it held the last copy and its log replays', async () => {
    const before = partition(await startCluster(['quay-a'], 0), 0)
    const acknowledged = new Map<string, string>()
    expect(await insertAcknowledged([...berthsIn(0, 15, 'tug'), ...berthsIn(1, 15, 'tug')], acknowledged)).toEqual([])

    disk.failSyncUnder = walOf('quay-a', 0)
    const [partitionZero, partitionOne] = await Promise.all([
      insertAcknowledged(berthsIn(0, 5, 'tug'), acknowledged),
      insertAcknowledged(berthsIn(1, 5, 'tug'), acknowledged),
    ])
    expect(disk.syncFailures).toBe(1)
    expect(partitionZero).toEqual([])
    expect(partitionOne).toEqual([])

    const served = await waitForAllocation(servedWith(0))
    expect(partition(served, 0).primary).toBe('quay-a')
    expect(partition(served, 0).primaryTerm).toBeGreaterThan(before.primaryTerm)
    expect(await insertAcknowledged(berthsIn(0, 5, 'tug'), acknowledged)).toEqual([])
    await expectOracle(acknowledged)
  }, 120_000)

  it('leaves the partition unassigned and reports it when the last copy cannot replay its log', async () => {
    await startCluster(['quay-a'], 0)
    const acknowledged = new Map<string, string>()
    expect(await insertAcknowledged([...berthsIn(0, 15, 'tug'), ...berthsIn(1, 15, 'tug')], acknowledged)).toEqual([])

    disk.failSyncUnder = walOf('quay-a', 0)
    disk.failReadsUnder = walOf('quay-a', 0)
    const refused = berthsIn(0, 5, 'tug')
    const partitionZero = insertAcknowledged(refused, acknowledged)

    const stranded = await waitForAllocation(
      table =>
        partition(table, 0).state === 'UNASSIGNED' && partition(table, 0).unassignedReason === 'HOLDER_WITHOUT_DATA',
    )
    expect(partition(stranded, 0).lastHolders).toEqual(['quay-a'])
    const reloadFailure = reported.find(
      error => error instanceof NarsilError && error.code === 'PERSISTENCE_LOAD_FAILED',
    )
    expect(reloadFailure).toBeInstanceOf(NarsilError)
    expect((reloadFailure as NarsilError).details).toMatchObject({ indexName: INDEX_NAME, partitionId: 0 })

    const partitionOne = berthsIn(1, 10, 'tug')
    expect(await insertAcknowledged(partitionOne, acknowledged)).toEqual([])
    const readBack = await router.getMultiple(
      INDEX_NAME,
      partitionOne.map(berth => berth.id),
    )
    expect(readBack.size).toBe(partitionOne.length)

    expect((await partitionZero).sort()).toEqual(refused.map(berth => berth.id).sort())
    expect(partition((await coordinator.getAllocation(INDEX_NAME)) as AllocationTable, 0).state).toBe('UNASSIGNED')
  }, 120_000)
})
