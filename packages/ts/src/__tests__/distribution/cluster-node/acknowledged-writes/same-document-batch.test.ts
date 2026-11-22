import { afterEach, describe, expect, it } from 'vitest'
import type { ForwardBatchOperation, WriteCondition } from '../../../../distribution/transport/types'
import { encodeDocument } from '../../../../serialization/document-encoding'
import { createTestCluster, INDEX, SCHEMA, type TestCluster, waitForCopies } from './harness'
import {
  BEYOND_EVERY_ENTRY,
  createWriteOracle,
  type Fields,
  type RecordedWrite,
  sendRetryBatch,
} from './write-record-oracle'

const ROUTER = 'router'
const PRIMARY = 'node-a'

function changedFields(documentId: string, updateFields: Fields): ForwardBatchOperation {
  return { documentId, operation: 'update', document: null, updateFields }
}

function attemptOnEarlierPrimary(previous: RecordedWrite, attempt: number): WriteCondition {
  return {
    ifSeqNo: previous.seqNo,
    ifPrimaryTerm: previous.primaryTerm,
    abandonedSeqNo: BEYOND_EVERY_ENTRY + 2 * attempt,
    abandonedPrimaryTerm: previous.primaryTerm,
    compensationSeqNo: BEYOND_EVERY_ENTRY + 2 * attempt + 1,
  }
}

function abandonedEntryOf(condition: WriteCondition): RecordedWrite {
  return { seqNo: condition.abandonedSeqNo, primaryTerm: condition.abandonedPrimaryTerm }
}

describe('several operations on one document in one forwarded batch', () => {
  let cluster: TestCluster | undefined

  afterEach(async () => {
    await cluster?.dispose()
    cluster = undefined
  })

  async function startPrimary(): Promise<TestCluster> {
    const started = await createTestCluster()
    cluster = started
    await started.start(ROUTER, { roles: ['controller', 'coordinator'], durable: false })
    await started.start(PRIMARY, { durable: false })
    await started.node(ROUTER).createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 0 })
    await waitForCopies(started.coordinator, PRIMARY, [])
    return started
  }

  it('keeps the fields of each earlier update when a later update in the batch changes other fields', async () => {
    const started = await startPrimary()
    const oracle = createWriteOracle(started, ROUTER)
    await oracle.insert('invoice', { title: 'draft invoice', amount: 10 })
    await oracle.insert('receipt', { title: 'draft receipt', amount: 20 })

    const answers = await sendRetryBatch(started, PRIMARY, [
      changedFields('invoice', { title: 'sent invoice' }),
      changedFields('invoice', { amount: 15 }),
      changedFields('receipt', { amount: 25 }),
      changedFields('invoice', { title: 'paid invoice' }),
      changedFields('missing', { amount: 1 }),
    ])

    expect(answers).toEqual(['accepted', 'accepted', 'accepted', 'accepted', 'DOC_NOT_FOUND'])
    await oracle.appliedRetry('invoice', { title: 'sent invoice', amount: 10 })
    await oracle.appliedRetry('invoice', { title: 'sent invoice', amount: 15 })
    await oracle.appliedRetry('receipt', { title: 'draft receipt', amount: 25 })
    await oracle.appliedRetry('invoice', { title: 'paid invoice', amount: 15 })
    await oracle.expectCopy(PRIMARY)
  }, 60_000)

  it('applies each resend that follows an earlier applied resend of the same document', async () => {
    const started = await startPrimary()
    const oracle = createWriteOracle(started, ROUTER)
    const invoiceBefore = await oracle.insert('invoice', { title: 'draft invoice', amount: 10 })
    const receiptBefore = await oracle.insert('receipt', { title: 'draft receipt', amount: 20 })
    const firstUpdate = attemptOnEarlierPrimary(invoiceBefore, 0)
    const secondUpdate = attemptOnEarlierPrimary(abandonedEntryOf(firstUpdate), 1)
    const thirdUpdate = attemptOnEarlierPrimary(abandonedEntryOf(secondUpdate), 2)
    const receiptUpdate = attemptOnEarlierPrimary(receiptBefore, 3)
    const receiptRemoval = attemptOnEarlierPrimary(abandonedEntryOf(receiptUpdate), 4)
    const unrelated = attemptOnEarlierPrimary(abandonedEntryOf(firstUpdate), 5)

    const answers = await sendRetryBatch(started, PRIMARY, [
      {
        documentId: 'invoice',
        operation: 'update',
        document: encodeDocument({ title: 'sent invoice', amount: 10 }),
        updateFields: null,
        ...firstUpdate,
      },
      {
        documentId: 'invoice',
        operation: 'update',
        document: encodeDocument({ title: 'sent invoice', amount: 15 }),
        updateFields: null,
        ...secondUpdate,
      },
      {
        documentId: 'receipt',
        operation: 'update',
        document: encodeDocument({ title: 'void receipt', amount: 0 }),
        updateFields: null,
        ...receiptUpdate,
      },
      { documentId: 'receipt', operation: 'remove', document: null, updateFields: null, ...receiptRemoval },
      {
        documentId: 'invoice',
        operation: 'update',
        document: encodeDocument({ title: 'paid invoice', amount: 15 }),
        updateFields: null,
        ...thirdUpdate,
      },
      {
        documentId: 'invoice',
        operation: 'update',
        document: encodeDocument({ title: 'disputed invoice', amount: 99 }),
        updateFields: null,
        ...unrelated,
      },
    ])

    expect(answers).toEqual(['accepted', 'accepted', 'accepted', 'accepted', 'accepted', 'REPLICATION_WRITE_CONFLICT'])
    await oracle.appliedRetry('invoice', { title: 'sent invoice', amount: 10 })
    await oracle.appliedRetry('invoice', { title: 'sent invoice', amount: 15 })
    await oracle.appliedRetry('receipt', { title: 'void receipt', amount: 0 })
    await oracle.appliedRetry('receipt', null)
    await oracle.appliedRetry('invoice', { title: 'paid invoice', amount: 15 })
    await oracle.expectCopy(PRIMARY)
  }, 60_000)
})
