import { afterEach, describe, expect, it } from 'vitest'
import type { PartitionAssignment } from '../../../../distribution/coordinator/types'
import {
  createTestCluster,
  INDEX,
  ofType,
  onceFor,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitUntil,
} from './harness'

const ROUTER = 'router'
const DATA_NODES = ['node-a', 'node-b', 'node-c']
const SEEDED = 20
const BATCH = 5
const SETTLE_TIMEOUT_MS = 30_000
const LARGE_BATCH = 2_500
const SLOW_FAILURE_MS = 11_000

type Ledger = Map<string, Record<string, unknown>>

function entry(label: string, amount: number): Record<string, unknown> {
  return { title: `transfer ${label}`, amount }
}

async function startCluster(): Promise<{ cluster: TestCluster; settled: PartitionAssignment; ledger: Ledger }> {
  const cluster = await createTestCluster()
  await cluster.start(ROUTER, { roles: ['controller', 'coordinator'], durable: false })
  for (const nodeId of DATA_NODES) await cluster.start(nodeId, { durable: false })
  await cluster.node(ROUTER).createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 2 })
  const settled = await waitUntil('every data node to hold the partition in sync', async () => {
    const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
    return current?.state === 'ACTIVE' && current.inSyncSet.length === 2 ? current : null
  })
  const ledger: Ledger = new Map()
  const seeded = Array.from({ length: SEEDED }, (_, i) => ({ id: `seeded-${i}`, ...entry(`s${i}`, i) }))
  expect((await cluster.node(ROUTER).insertBatch(INDEX, seeded)).failed).toEqual([])
  for (const { id, ...fields } of seeded) ledger.set(id, fields)
  return { cluster, settled, ledger }
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

describe('a forward that the transport fails to deliver to its primary', () => {
  let cluster: TestCluster | undefined

  afterEach(async () => {
    await cluster?.dispose()
    cluster = undefined
  })

  it('reaches the replica promoted after its primary stops, for an insert, an update and a remove batch', async () => {
    const started = await startCluster()
    cluster = started.cluster
    const { ledger } = started
    const router = cluster.node(ROUTER)
    const primary = started.settled.primary ?? ''
    const fresh = Array.from({ length: BATCH }, (_, i) => ({ id: `fresh-${i}`, ...entry(`f${i}`, 100 + i) }))
    const updates = Array.from({ length: BATCH }, (_, i) => ({
      docId: `seeded-${i}`,
      document: entry(`u${i}`, 200 + i),
    }))
    const removedIds = Array.from({ length: BATCH }, (_, i) => `seeded-${BATCH + i}`)

    const held = cluster.transport(ROUTER).holdWhen(ofType('replication.forward_batch', primary))
    const inserted = router.insertBatch(INDEX, fresh)
    const updated = router.updateBatch(INDEX, updates)
    const removed = router.removeBatch(INDEX, removedIds)
    await waitUntil('all three batches to wait on their way to the primary', () => held.count() === 3)
    await cluster.stop(primary)
    held.release()

    const results = { inserted: await inserted, updated: await updated, removed: await removed }
    expect(results.inserted.failed).toEqual([])
    expect(results.updated.failed).toEqual([])
    expect(results.removed.failed).toEqual([])
    expect([...results.inserted.succeeded].sort()).toEqual(fresh.map(document => document.id).sort())
    expect([...results.updated.succeeded].sort()).toEqual(updates.map(update => update.docId).sort())
    expect([...results.removed.succeeded].sort()).toEqual([...removedIds].sort())
    for (const { id, ...fields } of fresh) ledger.set(id, fields)
    for (const { docId, document } of updates) ledger.set(docId, document)
    for (const docId of removedIds) ledger.delete(docId)

    const promoted = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
    expect(promoted?.primary).not.toBe(primary)
    await expectEveryCopyHolds(cluster, ledger)
  }, 90_000)

  it('retries every chunk of a large batch when each send to the failed primary takes long to fail', async () => {
    const started = await startCluster()
    cluster = started.cluster
    const { ledger } = started
    const router = cluster.node(ROUTER)
    const primary = started.settled.primary ?? ''
    const toPrimary = ofType('replication.forward_batch', primary)
    let attempts = 0
    cluster.transport(ROUTER).failSlowlyWhen((target, message) => {
      if (!toPrimary(target, message)) return false
      attempts += 1
      return true
    }, SLOW_FAILURE_MS)
    const large = Array.from({ length: LARGE_BATCH }, (_, i) => ({ id: `large-${i}`, ...entry(`l${i}`, 1_000 + i) }))

    const inserted = router.insertBatch(INDEX, large)
    await waitUntil('the first chunk to head for the primary', () => attempts > 0)
    await cluster.stop(primary)
    const result = await inserted

    expect(result.failed).toEqual([])
    expect(new Set(result.succeeded)).toEqual(new Set(large.map(document => document.id)))
    for (const { id, ...fields } of large) ledger.set(id, fields)
    await expectEveryCopyHolds(cluster, ledger)
  }, 90_000)

  it.each([
    'insert',
    'update',
    'remove',
  ] as const)('acknowledges each %s once when the reply is lost after the primary applied it', async action => {
    const started = await startCluster()
    cluster = started.cluster
    const { ledger } = started
    const router = cluster.node(ROUTER)
    const primary = started.settled.primary ?? ''
    const transport = cluster.transport(ROUTER)
    transport.loseReplyWhen(onceFor(ofType('replication.forward_batch', primary)))
    transport.loseReplyWhen(onceFor(ofType('replication.forward', primary)))

    if (action === 'insert') {
      const batch = Array.from({ length: BATCH }, (_, i) => ({ id: `fresh-${i}`, ...entry(`f${i}`, 100 + i) }))
      const result = await router.insertBatch(INDEX, batch)
      expect(result.failed).toEqual([])
      expect(await router.insert(INDEX, entry('single', 7), 'fresh-single')).toBe('fresh-single')
      for (const { id, ...fields } of batch) ledger.set(id, fields)
      ledger.set('fresh-single', entry('single', 7))
    } else if (action === 'update') {
      const updates = Array.from({ length: BATCH }, (_, i) => ({
        docId: `seeded-${i}`,
        document: entry(`u${i}`, 200 + i),
      }))
      expect((await router.updateBatch(INDEX, updates)).failed).toEqual([])
      await router.update(INDEX, 'seeded-10', entry('single update', 9))
      for (const { docId, document } of updates) ledger.set(docId, document)
      ledger.set('seeded-10', entry('single update', 9))
    } else {
      const removedIds = Array.from({ length: BATCH }, (_, i) => `seeded-${i}`)
      expect((await router.removeBatch(INDEX, removedIds)).failed).toEqual([])
      await router.remove(INDEX, 'seeded-10')
      for (const docId of [...removedIds, 'seeded-10']) ledger.delete(docId)
    }

    await expectEveryCopyHolds(cluster, ledger)
  }, 90_000)
})
