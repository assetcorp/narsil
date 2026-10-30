import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CAPACITY } from '../../../../distribution'
import type { PartitionAssignment } from '../../../../distribution/coordinator/types'
import {
  createTestCluster,
  entryForDocument,
  INDEX,
  ofType,
  outcomeOf,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitUntil,
} from './harness'

const ROUTER = 'router'
const DATA_NODES = ['node-a', 'node-b', 'node-c']
const LARGE_NODE = 'node-d'
const LARGE_NODE_MEMORY_MULTIPLE = 40
const SETTLED_DOCUMENTS = 20
const BATCH_DOCUMENTS = 10
const SETTLE_TIMEOUT_MS = 30_000

type Ledger = Map<string, Record<string, unknown>>

function entry(id: string, amount: number): Record<string, unknown> {
  return { title: `transfer ${id}`, amount }
}

async function startHandoverCluster(): Promise<{ cluster: TestCluster; settled: PartitionAssignment }> {
  const cluster = await createTestCluster()
  await cluster.start(ROUTER, { roles: ['controller', 'coordinator'], durable: false })
  for (const nodeId of DATA_NODES) await cluster.start(nodeId, { durable: false })
  await cluster.node(ROUTER).createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 2 })
  const settled = await waitUntil('every data node to hold the partition in sync', async () => {
    const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
    return current?.state === 'ACTIVE' && current.inSyncSet.length === 2 ? current : null
  })
  return { cluster, settled }
}

async function handOverLeadership(cluster: TestCluster, settled: PartitionAssignment): Promise<string> {
  await cluster.start(LARGE_NODE, {
    durable: false,
    capacity: { ...DEFAULT_CAPACITY, memoryBytes: DEFAULT_CAPACITY.memoryBytes * LARGE_NODE_MEMORY_MULTIPLE },
  })
  const handedOver = await waitUntil('the controller to hand leadership to an in-sync replica', async () => {
    const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
    return current?.primary != null && current.primary !== settled.primary && current.primaryTerm > settled.primaryTerm
      ? current.primary
      : null
  })
  return handedOver
}

async function expectEveryCopyHolds(cluster: TestCluster, ledger: Ledger): Promise<void> {
  const expected = Object.fromEntries(ledger)
  const holders = await waitUntil(
    'every in-sync copy to hold the ledger',
    async () => {
      const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      if (current?.state !== 'ACTIVE' || current.primary === null) return null
      const nodeIds = [current.primary, ...current.inSyncSet]
      for (const nodeId of nodeIds) {
        const copy = Object.fromEntries(await readCopy(cluster.probe, nodeId))
        if (JSON.stringify(Object.keys(copy).sort()) !== JSON.stringify(Object.keys(expected).sort())) return null
      }
      return nodeIds
    },
    SETTLE_TIMEOUT_MS,
  )
  for (const nodeId of holders) {
    expect(Object.fromEntries(await readCopy(cluster.probe, nodeId)), nodeId).toEqual(expected)
  }
  expect(await cluster.node(ROUTER).countDocuments(INDEX)).toBe(ledger.size)
}

describe('a write in flight while its partition changes primary', () => {
  let cluster: TestCluster | undefined

  afterEach(async () => {
    await cluster?.dispose()
    cluster = undefined
  })

  it('answers outcome unknown for a remove batch and reaches the new primary with an insert batch', async () => {
    const started = await startHandoverCluster()
    cluster = started.cluster
    const router = cluster.node(ROUTER)
    const ledger: Ledger = new Map()
    const seeded = Array.from({ length: SETTLED_DOCUMENTS }, (_, i) => ({ id: `settled-${i}`, ...entry(`s${i}`, i) }))
    expect((await router.insertBatch(INDEX, seeded)).failed).toEqual([])
    for (const { id, ...fields } of seeded) ledger.set(id, fields)

    const removedIds = seeded.slice(0, BATCH_DOCUMENTS).map(document => document.id)
    const fresh = Array.from({ length: BATCH_DOCUMENTS }, (_, i) => ({ id: `fresh-${i}`, ...entry(`f${i}`, 100 + i) }))
    const held = cluster.transport(started.settled.primary ?? '').holdWhen(ofType('replication.entry_batch'))
    const removal = router.removeBatch(INDEX, removedIds)
    const insertion = router.insertBatch(INDEX, fresh)
    await waitUntil('the remove batch to reach both replicas', () => held.count() === 2)

    await handOverLeadership(cluster, started.settled)
    held.release()

    const removed = await removal
    const inserted = await insertion
    expect(removed.succeeded).toEqual([])
    expect(removed.failed.map(failure => failure.docId).sort()).toEqual([...removedIds].sort())
    for (const failure of removed.failed) expect(failure.error.code).toBe('REPLICATION_OUTCOME_UNKNOWN')
    expect(inserted.failed).toEqual([])
    expect([...inserted.succeeded].sort()).toEqual(fresh.map(document => document.id).sort())
    for (const { id, ...fields } of fresh) ledger.set(id, fields)

    await expectEveryCopyHolds(cluster, ledger)
  }, 90_000)

  it('stores a single insert once, whichever copy took the first attempt', async () => {
    const started = await startHandoverCluster()
    cluster = started.cluster
    const router = cluster.node(ROUTER)
    const lagging = started.settled.inSyncSet[1] ?? ''
    const held = cluster
      .transport(started.settled.primary ?? '')
      .holdWhen((target, message) => target === lagging && entryForDocument('transfer-1')(target, message))
    const write = outcomeOf(router.insert(INDEX, entry('t1', 7), 'transfer-1'))
    await waitUntil('the entry to stall on its way to one replica', () => held.count() === 1)

    await handOverLeadership(cluster, started.settled)
    held.release()

    expect(await write).toEqual({ state: 'acknowledged' })
    await expectEveryCopyHolds(cluster, new Map([['transfer-1', entry('t1', 7)]]))
  }, 90_000)

  it('refuses an insert whose id another client stored on the new primary between the attempts', async () => {
    const started = await startHandoverCluster()
    cluster = started.cluster
    const router = cluster.node(ROUTER)
    const held = cluster.transport(started.settled.primary ?? '').holdWhen(entryForDocument('transfer-2'))
    const write = outcomeOf(router.insert(INDEX, entry('first client', 1), 'transfer-2'))
    await waitUntil('the entry to stall on its way to both replicas', () => held.count() === 2)

    const newPrimary = await handOverLeadership(cluster, started.settled)
    await cluster.node(newPrimary).insert(INDEX, entry('second client', 2), 'transfer-2')
    held.release()

    expect(await write).toEqual({ state: 'refused', code: 'DOC_ALREADY_EXISTS' })
    await expectEveryCopyHolds(cluster, new Map([['transfer-2', entry('second client', 2)]]))
  }, 90_000)

  for (const operation of ['update', 'remove'] as const) {
    it(`answers outcome unknown for an ${operation} whose term ended, and keeps another client's newer write`, async () => {
      const started = await startHandoverCluster()
      cluster = started.cluster
      const router = cluster.node(ROUTER)
      await router.insert(INDEX, entry('opening', 1), 'transfer-3')
      await expectEveryCopyHolds(cluster, new Map([['transfer-3', entry('opening', 1)]]))
      const held = cluster.transport(started.settled.primary ?? '').holdWhen(entryForDocument('transfer-3'))
      const write = outcomeOf(
        operation === 'update'
          ? router.update(INDEX, 'transfer-3', entry('first client', 2))
          : router.remove(INDEX, 'transfer-3'),
      )
      await waitUntil('the entry to stall on its way to both replicas', () => held.count() === 2)

      const newPrimary = await handOverLeadership(cluster, started.settled)
      await cluster.node(newPrimary).update(INDEX, 'transfer-3', entry('second client', 3))
      held.release()

      expect(await write).toEqual({ state: 'refused', code: 'REPLICATION_OUTCOME_UNKNOWN' })
      await expectEveryCopyHolds(cluster, new Map([['transfer-3', entry('second client', 3)]]))
    }, 90_000)
  }
})
