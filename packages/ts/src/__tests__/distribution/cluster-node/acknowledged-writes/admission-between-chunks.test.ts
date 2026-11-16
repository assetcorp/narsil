import { setTimeout as sleep } from 'node:timers/promises'
import { decode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { CATCH_UP_TICK_MS } from '../../../../distribution/cluster-node/constants'
import { WIRE_BATCH_BUDGET } from '../../../../distribution/constants'
import type { TransportMessage } from '../../../../distribution/transport/types'
import {
  createTestCluster,
  INDEX,
  type MessageRule,
  ofType,
  onLinksTo,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitUntil,
  withClusterState,
} from './harness'

const SETTLED_WRITES = 4
const WRITES_PAST_FIRST_CHUNK = 10
const PUMP_TICKS_AFTER_ADMISSION = 3
const ADMISSION_TIMEOUT_MS = 30_000

function batchCarrying(documentId: string): MessageRule {
  return (_to: string, message: TransportMessage) => {
    if (message.type !== 'replication.entry_batch') return false
    const payload = decode(message.payload) as { entries?: Array<{ documentId?: unknown }> }
    return (payload.entries ?? []).some(entry => entry.documentId === documentId)
  }
}

describe('a replica that the controller admits while a batch replicates in more than one chunk', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it('receives every later chunk of that batch before the primary acknowledges it', async () => {
    cluster = await createTestCluster()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    for (const nodeId of ['node-a', 'node-b']) await cluster.start(nodeId, { durable: false })
    await cluster.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 2 })
    const settled = await waitUntil('the partition to hold one replica in sync', async () => {
      const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      return current?.state === 'ACTIVE' && current.inSyncSet.length === 1 ? current : null
    })
    const primary = settled.primary ?? ''
    const firstReplica = settled.inSyncSet[0] ?? ''

    const expected = new Map<string, Record<string, unknown>>()
    for (let i = 0; i < SETTLED_WRITES; i++) {
      await cluster.node(primary).insert(INDEX, { title: `settled ${i}`, amount: i }, `settled-${i}`)
      expected.set(`settled-${i}`, { title: `settled ${i}`, amount: i })
    }

    const heldAdmission = cluster.transport(primary).holdWhen(ofType('replication.insync_add', 'controller'))
    await cluster.start('node-c', { durable: false })
    await waitUntil('the primary to ask the controller to admit node-c', () => heldAdmission.count() > 0)

    const documents = []
    for (let i = 0; i < WIRE_BATCH_BUDGET.maxCount + WRITES_PAST_FIRST_CHUNK; i++) {
      documents.push({ id: `batch-${i}`, title: `batch ${i}`, amount: i })
      expected.set(`batch-${i}`, { title: `batch ${i}`, amount: i })
    }
    const heldFirstChunk = cluster.transport(primary).holdWhen(onLinksTo([firstReplica], batchCarrying('batch-0')))
    const batch = cluster.node(primary).insertBatch(INDEX, documents)
    batch.catch(() => undefined)
    await waitUntil('the first chunk to reach the link to the in-sync replica', () => heldFirstChunk.count() > 0)

    heldAdmission.release()
    await withClusterState(
      cluster,
      waitUntil(
        'node-c to join the in-sync set',
        async () => {
          const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
          return current?.inSyncSet.includes('node-c') === true ? current : null
        },
        ADMISSION_TIMEOUT_MS,
      ),
    )
    await sleep(CATCH_UP_TICK_MS * PUMP_TICKS_AFTER_ADMISSION)
    heldFirstChunk.release()

    expect((await batch).failed).toEqual([])

    await cluster.stop(firstReplica)
    await cluster.stop(primary)
    const promoted = await withClusterState(
      cluster,
      waitUntil(
        'node-c to take over',
        async () => {
          const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
          return current?.state === 'ACTIVE' && current.primary === 'node-c' ? current : null
        },
        ADMISSION_TIMEOUT_MS,
      ),
    )

    const copy = await readCopy(cluster.probe, promoted.primary ?? '')
    const lost = [...expected.keys()].filter(docId => !copy.has(docId))
    expect(lost).toEqual([])
    expect(Object.fromEntries(copy)).toEqual(Object.fromEntries(expected))
  }, 90_000)
})
