import type { NarsilError } from '../../../errors'
import type { BatchResult } from '../../../types/results'
import type { WriteCondition } from '../../transport/types'

export interface BatchWrite<V> {
  docId: string
  value: V
  condition?: WriteCondition
}

export interface WriteFailure<V> {
  write: BatchWrite<V>
  error: NarsilError
  withheld?: true
}

export interface BatchOutcome<V> {
  succeeded: BatchWrite<V>[]
  failed: WriteFailure<V>[]
}

export function batchResultOf<V>(outcome: BatchOutcome<V>): BatchResult {
  return {
    succeeded: outcome.succeeded.map(write => write.docId),
    failed: outcome.failed.map(failure => ({ docId: failure.write.docId, error: failure.error })),
  }
}
