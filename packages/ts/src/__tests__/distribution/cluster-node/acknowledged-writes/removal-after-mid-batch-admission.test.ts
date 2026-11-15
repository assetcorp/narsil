import { setTimeout as sleep } from 'node:timers/promises'
import { decode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { CATCH_UP_TICK_MS } from '../../../../distribution/cluster-node/constants'
import { WIRE_BATCH_BUDGET } from '../../../../distribution/constants'
import type { TransportMessage } from '../../../../distribution/transport/types'
import {
  createTestCluster,
  entryForDocument,
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
const WRITES_PAST_FIRST_CHUNK = 1
const PUMP_TICKS_AFTER_ADMISSION = 3
const ADMISSION_TIMEOUT_MS = 30_000

function batchCarrying(documentId: string): MessageRule {
  return (_to: string, message: TransportMessage) => {
    if (message.type !== 'replication.entry_batch') return false
    const payload = decode(message.payload) as { entries?: Array<{ documentId?: unknown }> }
    return (payload.entries ?? []).some(entry => entry.documentId === documentId)
  }
}

function chunkCarrying(documentId: string): MessageRule {
  return (to: string, message: TransportMessage) =>
    batchCarrying(documentId)(to, message) || entryForDocument(documentId)(to, message)
}

describe('a replica removed after its admission during a batch', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it('receives no later chunk after the controller removes its copy', async () => {
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
    await cluster.node('controller').cluster.setReplicationFactor(INDEX, 1)
    await waitUntil('node-c to leave the assignment', async () => {
      const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      return current !== undefined && !current.replicas.includes('node-c')
    })
    await sleep(CATCH_UP_TICK_MS * PUMP_TICKS_AFTER_ADMISSION)
    const laterChunks = cluster.transport('node-c').recordArrivalsWhen(chunkCarrying('batch-1000'))
    heldFirstChunk.release()

    expect((await batch).failed).toEqual([])

    expect(laterChunks).toEqual([])
    expect(Object.fromEntries(await readCopy(cluster.probe, firstReplica))).toEqual(Object.fromEntries(expected))
  }, 90_000)
})
