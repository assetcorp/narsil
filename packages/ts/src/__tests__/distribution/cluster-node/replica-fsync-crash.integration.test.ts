import { cp, mkdtemp, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator } from '../../../distribution/coordinator/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'
import { createNarsil } from '../../../narsil'

const disk = vi.hoisted(() => ({
  syncedBytes: new Map<string, number>(),
  stalledRoot: null as string | null,
  stallEntered: () => {},
  stallOutcome: null as Promise<void> | null,
}))

vi.mock('#platform/durable-fs', async importOriginal => {
  const original = await importOriginal<typeof import('../../../persistence/durability/node-fs')>()
  const fs = await original.getFs()
  type Handle = Awaited<ReturnType<typeof fs.open>>
  function tracked(path: string, handle: Handle): Handle {
    const sync = async (): Promise<void> => {
      const outcome = disk.stalledRoot !== null && path.startsWith(disk.stalledRoot) ? disk.stallOutcome : null
      if (outcome !== null) {
        disk.stallEntered()
        await outcome
      }
      await handle.sync()
      disk.syncedBytes.set(path, (await handle.stat()).size)
    }
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'sync') return sync
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  const open = async (...args: Parameters<typeof fs.open>): Promise<Handle> => {
    const handle = await fs.open(...args)
    const path = String(args[0])
    if (args[1] !== 'a') return handle
    if (!disk.syncedBytes.has(path)) disk.syncedBytes.set(path, (await handle.stat()).size)
    return tracked(path, handle)
  }
  return { ...original, getFs: async () => ({ ...fs, open }) }
})

const INDEX_NAME = 'lighthouse-logs'
const REPLICATION_TIMEOUT_MS = 1_500
const ALLOCATION_WAIT_MS = 30_000
const NO_ACK_WINDOW_MS = 500

type Entry = { id: string; keeper: string }

function entries(prefix: string, count: number): Entry[] {
  return Array.from({ length: count }, (_, n) => ({ id: `${prefix}-${n}`, keeper: `lamp keeper ${prefix} ${n}` }))
}

function settled(table: AllocationTable): boolean {
  const assignment = table.assignments.get(0)
  return (
    assignment !== undefined &&
    assignment.state === 'ACTIVE' &&
    assignment.primary !== null &&
    assignment.replicas.length === 1 &&
    assignment.inSyncSet.includes(assignment.replicas[0])
  )
}

describe('a replica that loses power between applying a batch and syncing it', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let root: string
  const running = new Map<string, ClusterNode>()
  let router: ClusterNode

  async function startDataNode(nodeId: string, directory: string): Promise<void> {
    const node = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport(nodeId, network, { replicationTimeout: REPLICATION_TIMEOUT_MS }),
      address: `${nodeId}:9200`,
      nodeId,
      roles: ['data'],
      engine: { workers: { enabled: false }, durability: { directory } },
    })
    running.set(nodeId, node)
    await node.start()
  }

  async function stopNode(nodeId: string): Promise<void> {
    const node = running.get(nodeId)
    running.delete(nodeId)
    await node?.shutdown()
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

  async function powerLossImage(nodeRoot: string, image: string): Promise<void> {
    await cp(nodeRoot, image, { recursive: true, filter: source => basename(source) !== '.narsil.lock' })
    for (const [path, bytes] of disk.syncedBytes) {
      if (path.startsWith(nodeRoot)) await truncate(join(image, relative(nodeRoot, path)), bytes)
    }
  }

  async function keepersIn(directory: string): Promise<Map<string, string>> {
    const reader = await createNarsil({ workers: { enabled: false }, durability: { directory } })
    try {
      const ids = (await reader.query(INDEX_NAME, { term: 'lamp', limit: 1_000 })).hits.map(hit => hit.id)
      const documents = await reader.getMultiple(INDEX_NAME, ids)
      return new Map([...documents].map(([id, document]) => [id, String(document.keeper)]))
    } finally {
      await reader.shutdown()
    }
  }

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    root = await mkdtemp(join(tmpdir(), 'narsil-replica-fsync-crash-'))
    disk.syncedBytes.clear()
    disk.stalledRoot = null
    disk.stallOutcome = null
    for (const nodeId of ['beacon-a', 'beacon-b']) await startDataNode(nodeId, join(root, nodeId))
    router = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport('router', network, { replicationTimeout: REPLICATION_TIMEOUT_MS }),
      address: 'router:9200',
      nodeId: 'router',
      roles: ['coordinator', 'controller'],
    })
    running.set('router', router)
    await router.start()
    await router.createIndex(INDEX_NAME, { schema: { keeper: 'string' } }, { partitionCount: 1, replicationFactor: 1 })
    await waitForAllocation(settled)
  })

  afterEach(async () => {
    disk.stalledRoot = null
    for (const nodeId of [...running.keys()]) await stopNode(nodeId).catch(() => {})
    await coordinator.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('acknowledges nothing it has not synced, and loses no acknowledged write', async () => {
    const assignment = (await waitForAllocation(settled)).assignments.get(0)
    const primary = assignment?.primary
    const replica = assignment?.replicas[0]
    if (primary == null || replica === undefined) throw new Error('partition 0 has no primary and replica')
    const replicaRoot = join(root, replica)
    const acknowledged = new Map<string, string>()
    const refused = new Set<string>()

    const first = entries('first', 40)
    expect((await router.insertBatch(INDEX_NAME, first)).failed).toEqual([])
    for (const entry of first) acknowledged.set(entry.id, entry.keeper)

    let powerCut: (error: Error) => void = () => {}
    disk.stallOutcome = new Promise<void>((_, reject) => {
      powerCut = reject
    })
    disk.stallOutcome.catch(() => {})
    const entered = new Promise<void>(resolve => {
      disk.stallEntered = resolve
    })
    disk.stalledRoot = replicaRoot

    const second = entries('second', 40)
    let answered = false
    const writing = router.insertBatch(INDEX_NAME, second).finally(() => {
      answered = true
    })
    const firstEvent = await Promise.race([
      entered.then(() => 'the replica began its fsync'),
      writing.then(() => 'the client was answered'),
    ])
    expect(firstEvent).toBe('the replica began its fsync')
    await new Promise(resolve => setTimeout(resolve, NO_ACK_WINDOW_MS))
    expect(answered).toBe(false)

    const image = join(root, `${replica}-after-power-loss`)
    await powerLossImage(replicaRoot, image)
    powerCut(new Error('simulated power loss during fsync'))
    await stopNode(replica).catch(() => {})
    disk.stalledRoot = null

    const outcome = await writing
    const failedIds = new Set(outcome.failed.map(failure => failure.docId))
    for (const entry of second) {
      if (failedIds.has(entry.id)) refused.add(entry.id)
      else acknowledged.set(entry.id, entry.keeper)
    }

    const inspected = join(root, `${replica}-inspected`)
    await cp(image, inspected, { recursive: true })
    const survived = await keepersIn(inspected)
    for (const entry of first) expect(survived.get(entry.id)).toBe(entry.keeper)

    await startDataNode(replica, image)
    await waitForAllocation(settled)
    await stopNode(primary)
    const promoted = await waitForAllocation(table => table.assignments.get(0)?.primary === replica)
    expect(promoted.assignments.get(0)?.state).toBe('ACTIVE')

    const read = await router.getMultiple(INDEX_NAME, [...acknowledged.keys(), ...refused])
    expect(new Map([...read].map(([id, document]) => [id, document.keeper]))).toEqual(acknowledged)
    const answer = await router.query(INDEX_NAME, { term: 'lamp', limit: 1_000 })
    expect(answer.hits.map(hit => hit.id).sort()).toEqual([...acknowledged.keys()].sort())
  }, 90_000)
})
