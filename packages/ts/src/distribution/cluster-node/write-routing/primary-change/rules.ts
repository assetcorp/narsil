import { ErrorCodes, NarsilError } from '../../../../errors'
import type { WriteCondition } from '../../../transport/types'
import { forwardInterrupted, forwardUnsent } from '../../transport-failure'
import { abandonedWriteOf, conditionOf } from '../abandoned-write'
import { interruptedOutcome } from '../forward-window'
import { refusedWhileInitialising } from '../initialising-partition'
import { abandonedWithTerm } from '../rollback'

export interface AttemptHistory {
  mayHaveApplied: boolean
  interrupted: boolean
  abandonedAttempt?: NarsilError
}

function refusedAsNotPrimary(error: unknown): error is NarsilError {
  return error instanceof NarsilError && error.code === ErrorCodes.PARTITION_NOT_PRIMARY
}

function refusedByPrimaryChange(error: unknown, retriesEndedTerm = false): boolean {
  if (refusedAsNotPrimary(error)) return true
  return abandonedWithTerm(error) && (retriesEndedTerm || abandonedWriteOf(error) !== undefined)
}

function refusedForAnotherIndex(error: unknown): boolean {
  return refusedAsNotPrimary(error) && typeof error.details.heldIndexUuid === 'string'
}

function cannotHaveApplied(error: unknown): boolean {
  return refusedAsNotPrimary(error) || forwardUnsent(error)
}

export function retriedAfterDelay(error: unknown): boolean {
  return (
    refusedForAnotherIndex(error) ||
    refusedWhileInitialising(error) ||
    forwardUnsent(error) ||
    forwardInterrupted(error)
  )
}

export function retriable(error: unknown, settlesAsEqual: boolean): boolean {
  return (
    refusedByPrimaryChange(error, settlesAsEqual) ||
    forwardUnsent(error) ||
    (settlesAsEqual && forwardInterrupted(error))
  )
}

export function nextCondition(error: unknown, current: WriteCondition | undefined): WriteCondition | undefined {
  const abandoned = abandonedWriteOf(error)
  return abandoned === undefined ? current : conditionOf(abandoned)
}

export function emptyHistory(): AttemptHistory {
  return { mayHaveApplied: false, interrupted: false }
}

export function recordAttempt(history: AttemptHistory, error: unknown): void {
  const endedTermFirst = !history.interrupted && history.abandonedAttempt === undefined
  if (endedTermFirst && error instanceof NarsilError && abandonedWithTerm(error)) history.abandonedAttempt = error
  history.interrupted ||= forwardInterrupted(error)
  history.mayHaveApplied ||= !cannotHaveApplied(error)
}

function decidedFromWriteRecord(error: unknown): boolean {
  return error instanceof NarsilError && error.code === ErrorCodes.REPLICATION_WRITE_CONFLICT
}

export function finalError<E>(
  history: AttemptHistory | undefined,
  indexName: string,
  docId: string,
  error: E,
): E | NarsilError {
  if (history?.abandonedAttempt !== undefined && !decidedFromWriteRecord(error)) return history.abandonedAttempt
  return history?.interrupted === true ? interruptedOutcome(indexName, docId, error) : error
}
