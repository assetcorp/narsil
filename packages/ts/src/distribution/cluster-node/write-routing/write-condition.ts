import { ErrorCodes, NarsilError } from '../../../errors'
import type { WriteCondition } from '../../transport/types'
import type { PrimaryWriteScope } from './numbered-write'

const CONDITION_FIELDS = [
  'ifSeqNo',
  'ifPrimaryTerm',
  'abandonedSeqNo',
  'abandonedPrimaryTerm',
  'compensationSeqNo',
] as const satisfies ReadonlyArray<keyof WriteCondition>

export type ConditionVerdict = 'apply' | 'acknowledge'

function isSequenceNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function conditionOfFields(
  fields: Readonly<Partial<Record<keyof WriteCondition, unknown>>>,
  operation: 'insert' | 'remove' | 'update',
  documentId: string,
): WriteCondition | undefined {
  const present = CONDITION_FIELDS.filter(field => fields[field] !== undefined && fields[field] !== null)
  if (present.length === 0) return undefined
  if (present.length !== CONDITION_FIELDS.length || operation === 'insert') {
    throw new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      operation === 'insert'
        ? `A forwarded insert of document '${documentId}' cannot carry a write condition`
        : `A forwarded ${operation} of document '${documentId}' must carry all five condition fields or none`,
      { documentId, operation, present },
    )
  }
  const values = CONDITION_FIELDS.map(field => fields[field])
  if (!values.every(isSequenceNumber)) {
    throw new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `The condition fields of a forwarded ${operation} of document '${documentId}' must be non-negative integers`,
      { documentId, operation },
    )
  }
  const [ifSeqNo, ifPrimaryTerm, abandonedSeqNo, abandonedPrimaryTerm, compensationSeqNo] = values
  return { ifSeqNo, ifPrimaryTerm, abandonedSeqNo, abandonedPrimaryTerm, compensationSeqNo }
}

function outcomeUnknownAfterRetry(scope: PrimaryWriteScope, documentId: string, because: string): NarsilError {
  return new NarsilError(
    ErrorCodes.REPLICATION_OUTCOME_UNKNOWN,
    `A write to document '${documentId}' in partition ${scope.partitionId} of index '${scope.indexName}' was sent again after the earlier primary's term ended, and ${because}, so the earlier attempt may or may not have taken effect. Read the document before you retry the write.`,
    {
      indexName: scope.indexName,
      partitionId: scope.partitionId,
      primaryTerm: scope.assignment.primaryTerm,
      reason: 'term_ended',
    },
  )
}

export function decideCondition(
  scope: PrimaryWriteScope,
  documentId: string,
  condition: WriteCondition,
): ConditionVerdict {
  const records = scope.deps.writeRecords
  const { indexName, partitionId } = scope
  const failed = records?.heldEntry(indexName, partitionId, condition.abandonedSeqNo, condition.abandonedPrimaryTerm)
  if (records === undefined || failed === undefined || failed === 'uncovered') {
    throw outcomeUnknownAfterRetry(scope, documentId, 'this copy no longer records the term of the earlier attempt')
  }
  if (failed === 'held') {
    const compensation = records.heldEntry(
      indexName,
      partitionId,
      condition.compensationSeqNo,
      condition.abandonedPrimaryTerm,
    )
    if (compensation === 'uncovered') {
      throw outcomeUnknownAfterRetry(scope, documentId, 'this copy no longer records the term of the earlier attempt')
    }
    if (compensation === 'absent') return 'acknowledge'
  }
  const record = records.recordOf(indexName, partitionId, documentId)
  if (record === null) {
    throw outcomeUnknownAfterRetry(scope, documentId, 'this copy holds no write record for the document')
  }
  const expectedSeqNo = failed === 'held' ? condition.compensationSeqNo : condition.ifSeqNo
  const expectedTerm = failed === 'held' ? condition.abandonedPrimaryTerm : condition.ifPrimaryTerm
  if (record.seqNo === expectedSeqNo && record.primaryTerm === expectedTerm) return 'apply'
  throw new NarsilError(
    ErrorCodes.REPLICATION_WRITE_CONFLICT,
    `Another write touched document '${documentId}' in index '${indexName}' after the earlier primary's attempt, so this primary refused the write that was sent again. The write did not take effect.`,
    { indexName, partitionId, documentId },
  )
}
