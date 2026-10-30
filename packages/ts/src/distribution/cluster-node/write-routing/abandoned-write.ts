import { NarsilError } from '../../../errors'
import type { ReplicationLogEntry } from '../../replication/types'
import type { AbandonedWrite, WriteCondition } from '../../transport/types'
import type { WriteRecord } from '../write-records/table'
import type { PrimaryWriteScope } from './numbered-write'
import { abandonedWithTerm } from './rollback'

const abandonedWrites = new WeakMap<NarsilError, AbandonedWrite>()

export function abandonedWriteOf(error: unknown): AbandonedWrite | undefined {
  return error instanceof NarsilError ? abandonedWrites.get(error) : undefined
}

export function withAbandonedWrite(error: NarsilError, write: AbandonedWrite): NarsilError {
  const marked = new NarsilError(error.code, error.message, error.details)
  abandonedWrites.set(marked, write)
  return marked
}

function isSequenceNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function abandonedWriteFrom(value: unknown): AbandonedWrite | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const { seqNo, primaryTerm, compensationSeqNo, previousSeqNo, previousPrimaryTerm } = record
  if (
    !isSequenceNumber(seqNo) ||
    !isSequenceNumber(primaryTerm) ||
    !isSequenceNumber(compensationSeqNo) ||
    !isSequenceNumber(previousSeqNo) ||
    !isSequenceNumber(previousPrimaryTerm)
  ) {
    return undefined
  }
  return { seqNo, primaryTerm, compensationSeqNo, previousSeqNo, previousPrimaryTerm }
}

export function previousRecordOf(scope: PrimaryWriteScope, documentId: string): WriteRecord | null {
  return scope.deps.writeRecords?.recordOf(scope.indexName, scope.partitionId, documentId) ?? null
}

export function markAbandoned(
  answer: unknown,
  failed: ReplicationLogEntry,
  compensation: ReplicationLogEntry | null,
  previous: WriteRecord | null | undefined,
): unknown {
  if (!(answer instanceof NarsilError) || !abandonedWithTerm(answer)) return answer
  if (compensation === null || previous === null || previous === undefined) return answer
  return withAbandonedWrite(answer, {
    seqNo: failed.seqNo,
    primaryTerm: failed.primaryTerm,
    compensationSeqNo: compensation.seqNo,
    previousSeqNo: previous.seqNo,
    previousPrimaryTerm: previous.primaryTerm,
  })
}

export function conditionOf(write: AbandonedWrite): WriteCondition {
  return {
    ifSeqNo: write.previousSeqNo,
    ifPrimaryTerm: write.previousPrimaryTerm,
    abandonedSeqNo: write.seqNo,
    abandonedPrimaryTerm: write.primaryTerm,
    compensationSeqNo: write.compensationSeqNo,
  }
}

export function conditionFields(condition: WriteCondition | undefined): Partial<WriteCondition> {
  if (condition === undefined) return {}
  return {
    ifSeqNo: condition.ifSeqNo,
    ifPrimaryTerm: condition.ifPrimaryTerm,
    abandonedSeqNo: condition.abandonedSeqNo,
    abandonedPrimaryTerm: condition.abandonedPrimaryTerm,
    compensationSeqNo: condition.compensationSeqNo,
  }
}
