import { afterEach, describe, expect, it } from 'vitest'
import { encodeDocument } from '../../../../serialization/document-encoding'
import { createTestCluster, INDEX, SCHEMA, type TestCluster, waitForCopies } from './harness'
import {
  BEYOND_EVERY_ENTRY,
  compensated,
  createWriteOracle,
  neverArrived,
  sendRetry,
  sendRetryBatch,
  tookEffect,
} from './write-record-oracle'

const ROUTER = 'router'
const PRIMARY = 'node-a'

function entry(title: string, amount: number): Record<string, unknown> {
  return { title, amount }
}

describe('a write sent again after the earlier primary term ended', () => {
  let cluster: TestCluster | undefined

  afterEach(async () => {
    await cluster?.dispose()
    cluster = undefined
  })

  it('decides each retry from what the primary holds, and decides the same way after a restart', async () => {
    cluster = await createTestCluster()
    await cluster.start(ROUTER, { roles: ['controller', 'coordinator'], durable: false })
    await cluster.start(PRIMARY)
    await cluster.node(ROUTER).createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 0 })
    await waitForCopies(cluster.coordinator, PRIMARY, [])
    const oracle = createWriteOracle(cluster, ROUTER)

    const keptBefore = await oracle.insert('kept', entry('kept', 1))
    const keptFailed = await oracle.update('kept', entry('kept', 2))
    const restoredFailed = await oracle.insert('restored', entry('restored', 3))
    const restoredBack = await oracle.update('restored', entry('restored', 4))
    const untouched = await oracle.insert('untouched', entry('untouched', 5))
    await cluster.node(PRIMARY).checkpoint(INDEX)
    const removed = await oracle.insert('removed', entry('removed', 6))
    const otherTerm = await oracle.insert('other-term', entry('other term', 7))

    expect(await sendRetry(cluster, PRIMARY, 'kept', tookEffect(keptFailed, keptBefore), entry('kept', 90))).toBe(
      'accepted',
    )
    expect(
      await sendRetry(cluster, PRIMARY, 'restored', compensated(restoredFailed, restoredBack), entry('restored', 91)),
    ).toBe('accepted')
    await oracle.appliedRetry('restored', entry('restored', 91))
    expect(
      await sendRetry(cluster, PRIMARY, 'restored', compensated(restoredFailed, restoredBack), entry('restored', 92)),
    ).toBe('REPLICATION_WRITE_CONFLICT')
    expect(await sendRetry(cluster, PRIMARY, 'untouched', neverArrived(untouched), entry('untouched', 93))).toBe(
      'accepted',
    )
    await oracle.appliedRetry('untouched', entry('untouched', 93))
    expect(await sendRetry(cluster, PRIMARY, 'untouched', neverArrived(untouched), entry('untouched', 94))).toBe(
      'REPLICATION_WRITE_CONFLICT',
    )
    expect(await sendRetry(cluster, PRIMARY, 'removed', neverArrived(removed), null)).toBe('accepted')
    await oracle.appliedRetry('removed', null)
    expect(await sendRetry(cluster, PRIMARY, 'removed', neverArrived(removed), null)).toBe(
      'REPLICATION_OUTCOME_UNKNOWN',
    )
    const underAnotherTerm = { ...otherTerm, primaryTerm: otherTerm.primaryTerm + 5 }
    expect(
      await sendRetry(cluster, PRIMARY, 'other-term', tookEffect(underAnotherTerm, otherTerm), entry('other term', 95)),
    ).toBe('accepted')
    await oracle.appliedRetry('other-term', entry('other term', 95))
    await oracle.expectCopy(PRIMARY)

    await cluster.stop(PRIMARY)
    await cluster.start(PRIMARY)
    await waitForCopies(cluster.coordinator, PRIMARY, [])

    expect(await sendRetry(cluster, PRIMARY, 'kept', tookEffect(keptFailed, keptBefore), entry('kept', 96))).toBe(
      'accepted',
    )
    expect(
      await sendRetry(cluster, PRIMARY, 'restored', compensated(restoredFailed, restoredBack), entry('restored', 97)),
    ).toBe('REPLICATION_WRITE_CONFLICT')
    expect(await sendRetry(cluster, PRIMARY, 'untouched', neverArrived(untouched), entry('untouched', 98))).toBe(
      'REPLICATION_WRITE_CONFLICT',
    )
    expect(await sendRetry(cluster, PRIMARY, 'removed', neverArrived(removed), null)).toBe(
      'REPLICATION_OUTCOME_UNKNOWN',
    )
    const latest = oracle.recordOf('other-term')
    expect(await sendRetry(cluster, PRIMARY, 'other-term', neverArrived(latest), entry('other term', 99))).toBe(
      'accepted',
    )
    await oracle.appliedRetry('other-term', entry('other term', 99))
    const afterRestart = await oracle.insert('after-restart', entry('after restart', 8))
    expect(
      await sendRetry(cluster, PRIMARY, 'after-restart', neverArrived(afterRestart), entry('after restart', 100)),
    ).toBe('accepted')
    await oracle.appliedRetry('after-restart', entry('after restart', 100))
    await oracle.expectCopy(PRIMARY)
  }, 60_000)

  it('refuses a malformed condition and decides each operation of a batch on its own', async () => {
    cluster = await createTestCluster()
    await cluster.start(ROUTER, { roles: ['controller', 'coordinator'], durable: false })
    await cluster.start(PRIMARY, { durable: false })
    await cluster.node(ROUTER).createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 0 })
    await waitForCopies(cluster.coordinator, PRIMARY, [])
    const oracle = createWriteOracle(cluster, ROUTER)
    const first = await oracle.insert('first', entry('first', 1))
    const second = await oracle.insert('second', entry('second', 2))
    const valid = neverArrived(first)

    const { compensationSeqNo: _left, ...partial } = valid
    expect(await sendRetry(cluster, PRIMARY, 'first', partial, entry('first', 10))).toBe('REPLICATION_ENTRY_INVALID')
    expect(await sendRetry(cluster, PRIMARY, 'first', { ...valid, ifSeqNo: -1 }, entry('first', 11))).toBe(
      'REPLICATION_ENTRY_INVALID',
    )
    expect(await sendRetry(cluster, PRIMARY, 'first', { ...valid, ifSeqNo: '1' }, entry('first', 12))).toBe(
      'REPLICATION_ENTRY_INVALID',
    )
    expect(await sendRetry(cluster, PRIMARY, 'first', { ...valid, ifSeqNo: 1.5 }, entry('first', 13))).toBe(
      'REPLICATION_ENTRY_INVALID',
    )
    await oracle.expectCopy(PRIMARY)

    const answers = await sendRetryBatch(cluster, PRIMARY, [
      {
        documentId: 'first',
        operation: 'update',
        document: encodeDocument(entry('first', 20)),
        updateFields: null,
        ...valid,
      },
      {
        documentId: 'second',
        operation: 'update',
        document: encodeDocument(entry('second', 21)),
        updateFields: null,
        ...neverArrived({ ...second, seqNo: second.seqNo + 1 }),
      },
      {
        documentId: 'third',
        operation: 'insert',
        document: encodeDocument(entry('third', 22)),
        updateFields: null,
        ...neverArrived(second),
      },
      { documentId: 'second', operation: 'remove', document: null, updateFields: null, ...partial },
      {
        documentId: 'absent',
        operation: 'remove',
        document: null,
        updateFields: null,
        ...neverArrived({ seqNo: BEYOND_EVERY_ENTRY, primaryTerm: first.primaryTerm }),
      },
    ])
    expect(answers).toEqual([
      'accepted',
      'REPLICATION_WRITE_CONFLICT',
      'REPLICATION_ENTRY_INVALID',
      'REPLICATION_ENTRY_INVALID',
      'REPLICATION_OUTCOME_UNKNOWN',
    ])
    await oracle.appliedRetry('first', entry('first', 20))
    await oracle.expectCopy(PRIMARY)
  }, 60_000)
})
