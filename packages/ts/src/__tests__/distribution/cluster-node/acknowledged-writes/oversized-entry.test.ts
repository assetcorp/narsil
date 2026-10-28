import { afterEach, describe, expect, it } from 'vitest'
import type { BatchResult } from '../../../../types/results'
import {
  createTestCluster,
  INDEX,
  outcomeOf,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitForCopies,
  waitUntil,
} from './harness'

const LOG_RETENTION_BYTES = 4096
const OVERSIZED_TITLE = `overdraft ${'x'.repeat(LOG_RETENTION_BYTES * 2)}`

async function singleWriteRefusal(write: Promise<unknown>): Promise<unknown> {
  const outcome = await outcomeOf(write)
  return outcome.state === 'refused' ? outcome.code : 'acknowledged'
}

async function batchWriteRefusal(write: Promise<BatchResult>, docId: string): Promise<unknown> {
  const result = await write
  const failure = result.failed.find(entry => entry.docId === docId)
  return failure === undefined ? 'acknowledged' : (failure.error as { code?: unknown }).code
}

const WRITES: Array<{
  name: string
  durable: boolean
  attempt: (cluster: TestCluster, primary: string) => Promise<unknown>
}> = [
  {
    name: 'an insert',
    durable: true,
    attempt: (cluster, primary) =>
      singleWriteRefusal(cluster.node(primary).insert(INDEX, { title: OVERSIZED_TITLE, amount: 1 }, 'account-new')),
  },
  {
    name: 'an update',
    durable: false,
    attempt: (cluster, primary) =>
      singleWriteRefusal(cluster.node(primary).update(INDEX, 'account-1', { title: OVERSIZED_TITLE, amount: 2 })),
  },
  {
    name: 'a batch insert',
    durable: false,
    attempt: (cluster, primary) =>
      batchWriteRefusal(
        cluster.node(primary).insertBatch(INDEX, [{ id: 'account-batch', title: OVERSIZED_TITLE, amount: 3 }]),
        'account-batch',
      ),
  },
  {
    name: 'a batch update',
    durable: true,
    attempt: (cluster, primary) =>
      batchWriteRefusal(
        cluster
          .node(primary)
          .updateBatch(INDEX, [{ docId: 'account-2', document: { title: OVERSIZED_TITLE, amount: 4 } }]),
        'account-2',
      ),
  },
]

describe('a write whose log entry is larger than the log retention limit', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  for (const write of WRITES) {
    it(`refuses ${write.name} on a ${write.durable ? 'durable' : 'memory-only'} primary and leaves every copy without it`, async () => {
      cluster = await createTestCluster()
      const replication = { logRetentionBytes: LOG_RETENTION_BYTES }
      await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
      for (const nodeId of ['node-a', 'node-b']) await cluster.start(nodeId, { durable: write.durable, replication })
      await cluster
        .node('controller')
        .createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
      const settled = await waitUntil('the partition to hold one replica in sync', async () => {
        const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
        return current?.state === 'ACTIVE' && current.inSyncSet.length === 1 ? current : null
      })
      const primary = settled.primary ?? ''
      const replica = settled.inSyncSet[0] ?? ''

      const expected = new Map<string, Record<string, unknown>>()
      for (const docId of ['account-1', 'account-2']) {
        const document = { title: `opening ${docId}`, amount: 0 }
        await cluster.node(primary).insert(INDEX, document, docId)
        expected.set(docId, document)
      }
      await waitForCopies(cluster.coordinator, primary, [replica])

      expect(await write.attempt(cluster, primary)).toBe('REPLICATION_LOG_FULL')

      expect(Object.fromEntries(await readCopy(cluster.probe, primary))).toEqual(Object.fromEntries(expected))
      expect(Object.fromEntries(await readCopy(cluster.probe, replica))).toEqual(Object.fromEntries(expected))
      const found = await cluster.node(primary).query(INDEX, { term: 'overdraft', limit: 10 })
      expect(found.hits).toEqual([])
    }, 60_000)
  }
})
