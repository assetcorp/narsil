import type { WriteCondition } from '../../../transport/types'
import { FORWARD_RETRY_INITIAL_DELAY_MS, PRIMARY_CHANGE_RETRY_WINDOW_MS } from '../../constants'
import type { BatchWrite } from '../batch-write'
import { beforeWindowEnds, WINDOW_ENDED, windowEndedOutcome } from '../forward-window'
import type { WriteRoutingDeps } from '../types'
import { emptyHistory, finalError, nextCondition, recordAttempt, retriable, retriedAfterDelay } from './rules'
import { type SettleRetried, settledBeforeWindowEnds } from './settlement'
import { awaitNewPrimary, nextRetryDelay, pauseAndRereadTable, primaryFor, tableBeforeWindowEnds } from './wait'

const NONE_ACKNOWLEDGED: ReadonlySet<string> = new Set()

export type SingleAttempt<T> = (condition: WriteCondition | undefined, deadline: number) => Promise<T>

export async function retryOnPrimaryChange<T, V>(
  deps: WriteRoutingDeps,
  indexName: string,
  write: BatchWrite<V>,
  attempt: SingleAttempt<T>,
  settleRetried: SettleRetried<V>,
  settledValue: () => T,
  settlesAsEqual = false,
): Promise<T> {
  const { docId } = write
  const deadline = Date.now() + PRIMARY_CHANGE_RETRY_WINDOW_MS
  const history = emptyHistory()
  let retryDelayMs = FORWARD_RETRY_INITIAL_DELAY_MS
  let condition: WriteCondition | undefined
  let lastRefusal: { error: unknown } | undefined
  for (;;) {
    const table = await tableBeforeWindowEnds(deps, indexName, deadline)
    if (table === WINDOW_ENDED) {
      if (lastRefusal === undefined) throw windowEndedOutcome(indexName, docId)
      throw finalError(history, indexName, docId, lastRefusal.error)
    }
    const refusing = primaryFor(table, docId)
    let outcome: T | typeof WINDOW_ENDED
    try {
      outcome = await beforeWindowEnds(attempt(condition, deadline), deadline)
    } catch (error) {
      if (history.mayHaveApplied) {
        const settling = settleRetried([{ write, error }], NONE_ACKNOWLEDGED)
        const settlement = await settledBeforeWindowEnds(settling, deadline)
        if (settlement.settled.has(write)) return settledValue()
        if (settlement.unverified.has(write) && history.abandonedAttempt !== undefined) {
          throw finalError(history, indexName, docId, history.abandonedAttempt)
        }
      }
      recordAttempt(history, error)
      if (!retriable(error, settlesAsEqual) || refusing === null) throw finalError(history, indexName, docId, error)
      let retryable: boolean
      if (retriedAfterDelay(error)) {
        retryable = await pauseAndRereadTable(deps, indexName, retryDelayMs, deadline)
        retryDelayMs = nextRetryDelay(retryDelayMs)
      } else {
        retryable = await awaitNewPrimary(deps, indexName, [refusing], deadline)
      }
      if (!retryable) throw finalError(history, indexName, docId, error)
      lastRefusal = { error }
      condition = nextCondition(error, condition)
      continue
    }
    if (outcome === WINDOW_ENDED) throw windowEndedOutcome(indexName, docId)
    return outcome
  }
}
