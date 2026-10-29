import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator, NodeRegistration } from '../../../distribution/coordinator/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'
import type { NodeTransport, TransportMessage } from '../../../distribution/transport/types'

const disk = vi.hoisted(() => ({
  stalledRoot: null as string | null,
  entered: null as (() => void) | null,
  gate: Promise.resolve(),
}))

vi.mock('#platform/durable-fs', async importOriginal => {
  const original = await importOriginal<typeof import('../../../persistence/durability/node-fs')>()
  const fs = await original.getFs()
  const rename = async (...args: Parameters<typeof fs.rename>): Promise<void> => {
    const target = String(args[1])
    if (disk.stalledRoot !== null && target.startsWith(disk.stalledRoot) && target.endsWith(`${sep}meta`)) {
      disk.stalledRoot = null
      disk.entered?.()
      await disk.gate
    }
    return fs.rename(...args)
  }
  return { ...original, getFs: async () => ({ ...fs, rename }) }
})

const INDEX_NAME = 'ferry-manifests'
const DATA_NODES = ['quay-a', 'quay-b']
const ALLOCATION_WAIT_MS = 30_000
const FIRST_WRITES = 60
const NEW_TERM_WRITES = 10
const HELD_TYPES = new Set(['replication.entry', 'replication.entry_batch'])
const RESYNC_SETTLE_MS = 500

type Manifest = { id: string; cargo: string }

function manifests(prefix: string, count: number, cargo: string): Manifest[] {
  return Array.from({ length: count }, (_, n) => ({ id: `${prefix}-${n}`, cargo: `${cargo} crate ${n}` }))
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

describe('a former primary that rejoins with a tail the new primary never saw', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let root: string
  const running = new Map<string, ClusterNode>()
  let router: ClusterNode
  let openGate = () => {}
  const hold = { from: null as string | null, held: [] as (() => void)[], heldCount: 0, resyncsDone: 0 }

  function holdingTransport(nodeId: string): NodeTransport {
    const inner = createInMemoryTransport(nodeId, network, { replicationTimeout: 60_000 })
    return {
      ...inner,
      send: async (target: string, message: TransportMessage) => {
        if (hold.from === nodeId && HELD_TYPES.has(message.type)) {
          hold.heldCount += 1
          await new Promise<void>(resolve => hold.held.push(resolve))
        }
        return inner.send(target, message)
      },
      stream: async (target: string, message: TransportMessage, handler: (chunk: Uint8Array) => void) => {
        await inner.stream(target, message, handler)
        if (hold.from === nodeId && message.type === 'replication.sync_request') hold.resyncsDone += 1
      },
    }
  }

  async function startDataNode(nodeId: string): Promise<void> {
    const node = await createClusterNode({
      coordinator,
      transport: holdingTransport(nodeId),
      address: `${nodeId}:9200`,
      nodeId,
      roles: ['data'],
      engine: { workers: { enabled: false }, durability: { directory: join(root, nodeId) } },
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

  async function readCargo(ids: string[]): Promise<Map<string, string>> {
    const read = await router.getMultiple(INDEX_NAME, ids)
    return new Map([...read].map(([id, document]) => [id, String(document.cargo)]))
  }

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    root = await mkdtemp(join(tmpdir(), 'narsil-former-primary-tail-'))
    hold.from = null
    hold.held = []
    hold.heldCount = 0
    hold.resyncsDone = 0
    disk.stalledRoot = null
    disk.entered = null
    disk.gate = Promise.resolve()
    for (const nodeId of DATA_NODES) await startDataNode(nodeId)
    router = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport('router', network),
      address: 'router:9200',
      nodeId: 'router',
      roles: ['coordinator', 'controller'],
    })
    running.set('router', router)
    await router.start()
    await router.createIndex(INDEX_NAME, { schema: { cargo: 'string' } }, { partitionCount: 1, replicationFactor: 1 })
    await waitForAllocation(settled)
  })

  afterEach(async () => {
    disk.stalledRoot = null
    openGate()
    hold.from = null
    for (const release of hold.held.splice(0)) release()
    for (const nodeId of [...running.keys()]) await stopNode(nodeId).catch(() => {})
    await coordinator.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('drops the tail, resyncs from the new primary, and keeps serving writes', async () => {
    const before = (await waitForAllocation(settled)).assignments.get(0)
    const formerPrimary = before?.primary
    const newPrimary = before?.replicas[0]
    if (formerPrimary == null || newPrimary === undefined) throw new Error('partition 0 has no primary and replica')
    const acknowledged = new Map<string, string>()

    const first = manifests('manifest', FIRST_WRITES, 'salt')
    expect((await router.insertBatch(INDEX_NAME, first)).failed).toEqual([])
    for (const entry of first) acknowledged.set(entry.id, entry.cargo)

    hold.from = formerPrimary
    const tailUpdates = manifests('manifest', FIRST_WRITES, 'tea').map(({ id, cargo }) => ({
      docId: id,
      document: { cargo },
    }))
    const tailWrite = router.updateBatch(INDEX_NAME, tailUpdates).catch((error: unknown) => error)
    const heldDeadline = Date.now() + ALLOCATION_WAIT_MS
    while (hold.heldCount < 1 && Date.now() < heldDeadline) await new Promise(resolve => setTimeout(resolve, 10))
    expect(hold.heldCount).toBeGreaterThanOrEqual(1)

    const registration = (await coordinator.listNodes()).find(node => node.nodeId === formerPrimary)
    if (registration === undefined) throw new Error(`${formerPrimary} is not registered`)
    await coordinator.deregisterNode(formerPrimary)
    const promoted = await waitForAllocation(table => table.assignments.get(0)?.primary === newPrimary)
    expect(promoted.assignments.get(0)?.primaryTerm).toBeGreaterThan(before?.primaryTerm ?? 0)

    const newTerm = manifests('manifest', NEW_TERM_WRITES, 'coal')
    const newTermResult = await router.updateBatch(
      INDEX_NAME,
      newTerm.map(({ id, cargo }) => ({ docId: id, document: { cargo } })),
    )
    expect(newTermResult.failed).toEqual([])
    for (const entry of newTerm) acknowledged.set(entry.id, entry.cargo)
    const fresh = manifests('fresh', NEW_TERM_WRITES, 'coal')
    expect((await router.insertBatch(INDEX_NAME, fresh)).failed).toEqual([])
    for (const entry of fresh) acknowledged.set(entry.id, entry.cargo)

    disk.gate = new Promise<void>(resolve => {
      openGate = resolve
    })
    const logRestarting = new Promise<void>(resolve => {
      disk.entered = resolve
    })
    disk.stalledRoot = join(root, formerPrimary)
    await coordinator.registerNode(registration as NodeRegistration)
    const resyncDeadline = Date.now() + ALLOCATION_WAIT_MS
    while (hold.resyncsDone < 1 && Date.now() < resyncDeadline) await new Promise(resolve => setTimeout(resolve, 10))
    expect(hold.resyncsDone).toBeGreaterThanOrEqual(1)
    await Promise.race([logRestarting, new Promise(resolve => setTimeout(resolve, RESYNC_SETTLE_MS))])

    hold.from = null
    for (const release of hold.held.splice(0)) release()
    setTimeout(openGate, RESYNC_SETTLE_MS)
    const tailOutcome = await tailWrite
    if (tailOutcome instanceof Error) throw tailOutcome
    const tail = tailOutcome as { succeeded: string[]; failed: { docId: string }[] }
    expect(tail.succeeded.length + tail.failed.length).toBe(FIRST_WRITES)
    for (const docId of tail.succeeded) {
      const update = tailUpdates.find(candidate => candidate.docId === docId)
      if (update === undefined) throw new Error(`the tail batch acknowledged ${docId}, which it never sent`)
      acknowledged.set(docId, update.document.cargo)
    }

    await waitForAllocation(
      table =>
        settled(table) &&
        table.assignments.get(0)?.primary === newPrimary &&
        table.assignments.get(0)?.replicas[0] === formerPrimary,
    )

    await stopNode(newPrimary)
    await waitForAllocation(table => table.assignments.get(0)?.primary === formerPrimary)
    const after = manifests('after', 10, 'grain')
    expect((await router.insertBatch(INDEX_NAME, after)).failed).toEqual([])
    for (const entry of after) acknowledged.set(entry.id, entry.cargo)

    expect(await readCargo([...acknowledged.keys()])).toEqual(acknowledged)
    const answer = await router.query(INDEX_NAME, { term: 'crate', limit: 1_000 })
    expect(answer.hits.map(hit => hit.id).sort()).toEqual([...acknowledged.keys()].sort())
  }, 120_000)
})
