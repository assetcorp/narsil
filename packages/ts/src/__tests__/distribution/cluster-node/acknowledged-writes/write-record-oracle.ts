import { decode } from '@msgpack/msgpack'
import { expect } from 'vitest'
import { createForwardBatchMessage, createForwardMessage } from '../../../../distribution/replication/codec'
import type { ForwardBatchOperation, WriteCondition } from '../../../../distribution/transport/types'
import { encodeDocument } from '../../../../serialization/document-encoding'
import { INDEX, partitionAssignment, readCopy, type TestCluster } from './harness'

export const BEYOND_EVERY_ENTRY = 1_000_000

export interface RecordedWrite {
  seqNo: number
  primaryTerm: number
}

export type Fields = Record<string, unknown>

export interface WriteOracle {
  readonly documents: Map<string, Fields>
  recordOf(docId: string): RecordedWrite
  insert(docId: string, fields: Fields): Promise<RecordedWrite>
  update(docId: string, fields: Fields): Promise<RecordedWrite>
  remove(docId: string): Promise<void>
  appliedRetry(docId: string, fields: Fields | null): Promise<void>
  expectCopy(nodeId: string): Promise<void>
}

export function createWriteOracle(cluster: TestCluster, router: string, lastSeqNo = 0): WriteOracle {
  const documents = new Map<string, Fields>()
  const records = new Map<string, RecordedWrite>()
  let seqNo = lastSeqNo

  async function numbered(docId: string, fields: Fields | null): Promise<RecordedWrite> {
    const primaryTerm = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))?.primaryTerm ?? 0
    seqNo += 1
    const written = { seqNo, primaryTerm }
    if (fields === null) {
      documents.delete(docId)
      records.delete(docId)
    } else {
      documents.set(docId, fields)
      records.set(docId, written)
    }
    return written
  }

  return {
    documents,
    recordOf(docId) {
      const written = records.get(docId)
      if (written === undefined) throw new Error(`the oracle holds no write of ${docId}`)
      return written
    },
    async insert(docId, fields) {
      await cluster.node(router).insert(INDEX, fields, docId)
      return numbered(docId, fields)
    },
    async update(docId, fields) {
      await cluster.node(router).update(INDEX, docId, fields)
      return numbered(docId, fields)
    },
    async remove(docId) {
      await cluster.node(router).remove(INDEX, docId)
      await numbered(docId, null)
    },
    async appliedRetry(docId, fields) {
      await numbered(docId, fields)
    },
    async expectCopy(nodeId) {
      expect(Object.fromEntries(await readCopy(cluster.probe, nodeId)), nodeId).toEqual(Object.fromEntries(documents))
    },
  }
}

export function tookEffect(failed: RecordedWrite, previous: RecordedWrite): WriteCondition {
  return {
    ifSeqNo: previous.seqNo,
    ifPrimaryTerm: previous.primaryTerm,
    abandonedSeqNo: failed.seqNo,
    abandonedPrimaryTerm: failed.primaryTerm,
    compensationSeqNo: BEYOND_EVERY_ENTRY,
  }
}

export function compensated(failed: RecordedWrite, compensation: RecordedWrite): WriteCondition {
  return {
    ifSeqNo: failed.seqNo,
    ifPrimaryTerm: failed.primaryTerm,
    abandonedSeqNo: failed.seqNo,
    abandonedPrimaryTerm: failed.primaryTerm,
    compensationSeqNo: compensation.seqNo,
  }
}

export function neverArrived(previous: RecordedWrite): WriteCondition {
  return {
    ifSeqNo: previous.seqNo,
    ifPrimaryTerm: previous.primaryTerm,
    abandonedSeqNo: BEYOND_EVERY_ENTRY,
    abandonedPrimaryTerm: previous.primaryTerm,
    compensationSeqNo: BEYOND_EVERY_ENTRY + 1,
  }
}

function answerOf(payload: { success?: unknown; code?: unknown; errorCode?: unknown }): string {
  if (payload.success === true) return 'accepted'
  return String(payload.code ?? payload.errorCode)
}

export async function sendRetry(
  cluster: TestCluster,
  primary: string,
  docId: string,
  condition: Partial<Record<keyof WriteCondition, unknown>>,
  fields: Fields | null,
): Promise<string> {
  const response = await cluster.probe.send(
    primary,
    createForwardMessage(
      {
        indexName: INDEX,
        documentId: docId,
        operation: fields === null ? 'remove' : 'update',
        document: fields === null ? null : encodeDocument(fields),
        updateFields: null,
        ...(condition as Partial<WriteCondition>),
      },
      'copy-reader',
    ),
  )
  return answerOf(decode(response.payload) as { success?: unknown; code?: unknown })
}

export async function sendRetryBatch(
  cluster: TestCluster,
  primary: string,
  operations: ForwardBatchOperation[],
): Promise<string[]> {
  const response = await cluster.probe.send(
    primary,
    createForwardBatchMessage({ indexName: INDEX, operations }, 'copy-reader'),
  )
  const payload = decode(response.payload) as { results?: Array<{ success?: unknown; errorCode?: unknown }> }
  return (payload.results ?? []).map(answerOf)
}
