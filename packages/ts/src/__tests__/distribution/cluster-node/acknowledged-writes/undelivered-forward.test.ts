import { afterEach, describe, expect, it } from 'vitest'
import type { PartitionAssignment } from '../../../../distribution/coordinator/types'
import {
  createTestCluster,
  INDEX,
  ofType,
  onceFor,
  outcomeOf,
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

  it('reaches the replica promoted after its primary stops, for an insert, an update and a remove, one by one and in batches', async () => {
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

    const routerTransport = cluster.transport(ROUTER)
    const toPrimary = (target: string, message: { type: string }) =>
      target === primary && message.type.startsWith('replication.forward')
    const held = routerTransport.holdWhen(toPrimary)
    const inserted = router.insertBatch(INDEX, fresh)
    const updated = router.updateBatch(INDEX, updates)
    const removed = router.removeBatch(INDEX, removedIds)
    const updatedOne = router.update(INDEX, 'seeded-15', entry('single update', 300))
    const removedOne = router.remove(INDEX, 'seeded-16')
    await waitUntil('all five writes to wait on their way to the primary', () => held.count() === 5)
    await cluster.stop(primary)
    held.release()

    await updatedOne
    await removedOne
    ledger.set('seeded-15', entry('single update', 300))
    ledger.delete('seeded-16')
    const results = { inserted: await inserted, updated: await updated, removed: await removed }
    const failures = routerTransport.failuresOf(toPrimary)
    expect(failures.length).toBeGreaterThanOrEqual(5)
    expect(new Set(failures)).toEqual(new Set(['TRANSPORT_CONNECT_FAILED']))
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

  it('acknowledges each insert once when the reply is lost after the primary applied it', async () => {
    const started = await startCluster()
    cluster = started.cluster
    const { ledger } = started
    const router = cluster.node(ROUTER)
    const primary = started.settled.primary ?? ''
    const transport = cluster.transport(ROUTER)
    transport.loseReplyWhen(onceFor(ofType('replication.forward_batch', primary)))
    transport.loseReplyWhen(onceFor(ofType('replication.forward', primary)))

    const batch = Array.from({ length: BATCH }, (_, i) => ({ id: `fresh-${i}`, ...entry(`f${i}`, 100 + i) }))
    const result = await router.insertBatch(INDEX, batch)
    expect(result.failed).toEqual([])
    expect(await router.insert(INDEX, entry('single', 7), 'fresh-single')).toBe('fresh-single')
    for (const { id, ...fields } of batch) ledger.set(id, fields)
    ledger.set('fresh-single', entry('single', 7))

    await expectEveryCopyHolds(cluster, ledger)
  }, 90_000)

  it.each([
    'update',
    'remove',
  ] as const)('answers each %s whose reply is lost after the primary applied it with an unknown outcome, never a second apply', async action => {
    const started = await startCluster()
    cluster = started.cluster
    const { ledger } = started
    const router = cluster.node(ROUTER)
    const primary = started.settled.primary ?? ''
    const transport = cluster.transport(ROUTER)
    transport.loseReplyWhen(onceFor(ofType('replication.forward_batch', primary)))
    transport.loseReplyWhen(onceFor(ofType('replication.forward', primary)))
    const batchIds = Array.from({ length: BATCH }, (_, i) => `seeded-${i}`)

    let result: Awaited<ReturnType<typeof router.removeBatch>>
    let single: Promise<unknown>
    if (action === 'update') {
      const updates = batchIds.map((docId, i) => ({ docId, document: entry(`u${i}`, 200 + i) }))
      result = await router.updateBatch(INDEX, updates)
      single = router.update(INDEX, 'seeded-10', entry('single update', 9))
      for (const { docId, document } of updates) ledger.set(docId, document)
      ledger.set('seeded-10', entry('single update', 9))
    } else {
      result = await router.removeBatch(INDEX, batchIds)
      single = router.remove(INDEX, 'seeded-10')
      for (const docId of [...batchIds, 'seeded-10']) ledger.delete(docId)
    }

    expect(result.succeeded).toEqual([])
    expect(result.failed.map(failure => [failure.docId, failure.error.code, failure.error.details.reason])).toEqual(
      batchIds.map(docId => [docId, 'REPLICATION_OUTCOME_UNKNOWN', 'forward_interrupted']),
    )
    await expect(single).rejects.toMatchObject({
      code: 'REPLICATION_OUTCOME_UNKNOWN',
      details: { reason: 'forward_interrupted' },
    })
    await expectEveryCopyHolds(cluster, ledger)
  }, 90_000)

  it('answers an update whose reply was lost, and whose primary restarts unready, with its outcome and never a refusal', async () => {
    const started = await startCluster()
    cluster = started.cluster
    const running = cluster
    const { ledger } = started
    const router = running.node(ROUTER)
    const primary = started.settled.primary ?? ''
    const transport = running.transport(ROUTER)
    const toPrimary = ofType('replication.forward', primary)
    transport.loseReplyWhen(onceFor(toPrimary))
    let forwards = 0
    const resend = transport.holdWhen((target, message) => {
      if (!toPrimary(target, message)) return false
      forwards += 1
      return forwards > 1
    })

    let answered = false
    const update = outcomeOf(router.update(INDEX, 'seeded-0', entry('lost reply', 300))).finally(() => {
      answered = true
    })
    await waitUntil('the router to answer or to send the update again', () => answered || resend.count() > 0)
    if (!answered) {
      running.coordinator.refuseRegistrationOf(primary)
      await running.stop(primary)
      await expect(running.start(primary, { durable: false })).rejects.toThrow()
      resend.release()
    }

    const outcome = await update
    expect(outcome.state === 'acknowledged' ? outcome.state : outcome.code).toMatch(
      /^(acknowledged|REPLICATION_OUTCOME_UNKNOWN)$/,
    )
    ledger.set('seeded-0', entry('lost reply', 300))
    await expectEveryCopyHolds(running, ledger)
    await running.transport(primary).shutdown()
  }, 90_000)
})
