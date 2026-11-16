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
const PUMP_TICKS_AFTER_ADMISSION = 3
const ADMISSION_TIMEOUT_MS = 30_000

function batchCarrying(documentId: string): MessageRule {
  return (_to: string, message: TransportMessage) => {
    if (message.type === 'replication.entry') {
      const payload = decode(message.payload) as { entry?: { documentId?: unknown } }
      return payload.entry?.documentId === documentId
    }
    if (message.type !== 'replication.entry_batch') return false
    const payload = decode(message.payload) as { entries?: Array<{ documentId?: unknown }> }
    return (payload.entries ?? []).some(entry => entry.documentId === documentId)
  }
}

describe('a replica admitted while its batch fails', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it.each([1, WIRE_BATCH_BUDGET.maxCount])('leaves the in-sync set before %i writes are acknowledged', async count => {
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
    for (let i = 0; i < count; i++) {
      documents.push({ id: `batch-${i}`, title: `batch ${i}`, amount: i })
      expected.set(`batch-${i}`, { title: `batch ${i}`, amount: i })
    }
    const heldFirstChunk = cluster.transport(primary).holdWhen(onLinksTo([firstReplica], batchCarrying('batch-0')))
    cluster.transport(primary).dropWhen(onLinksTo(['node-c'], batchCarrying('batch-0')))
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

    const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
    expect(current?.inSyncSet).not.toContain('node-c')
    expect(Object.fromEntries(await readCopy(cluster.probe, firstReplica))).toEqual(Object.fromEntries(expected))
    await cluster.stop(primary)
    await waitUntil('the complete replica to become primary', async () => {
      const assignment = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      return assignment?.state === 'ACTIVE' && assignment.primary === firstReplica
    })
    expect(Object.fromEntries(await readCopy(cluster.probe, firstReplica))).toEqual(Object.fromEntries(expected))
  }, 90_000)
})
