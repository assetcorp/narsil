import type { WriteCondition } from '../../../transport/types'
import { FORWARD_RETRY_INITIAL_DELAY_MS, PRIMARY_CHANGE_RETRY_WINDOW_MS } from '../../constants'
import type { BatchWrite } from '../batch-write'
import {
  type AttemptWindow,
  openAttemptWindow,
  startedBeforeWindowEnds,
  unsentWindowEndedOutcome,
  WINDOW_ENDED,
  windowEndedBeforeSending,
  windowEndedOutcome,
} from '../forward-window'
import type { WriteRoutingDeps } from '../types'
import { emptyHistory, finalError, nextCondition, recordAttempt, retriable, retriedAfterDelay } from './rules'
import { type SettleRetried, settledBeforeWindowEnds } from './settlement'
import { awaitNewPrimary, nextRetryDelay, pauseAndRereadTable, primaryFor, tableBeforeWindowEnds } from './wait'

const NONE_ACKNOWLEDGED: ReadonlySet<string> = new Set()

export type SingleAttempt<T> = (condition: WriteCondition | undefined, window: AttemptWindow) => Promise<T>

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
    const window = openAttemptWindow(deadline)
    try {
      const outcome = await startedBeforeWindowEnds(attempt(condition, window), window, deps.shutdownSignal)
      if (outcome !== WINDOW_ENDED) return outcome
      throw unsentWindowEndedOutcome(indexName, docId, deps.shutdownSignal)
    } catch (error) {
      if (windowEndedBeforeSending(error)) {
        if (lastRefusal === undefined) throw error
        throw finalError(history, indexName, docId, lastRefusal.error)
      }
      if (history.mayHaveApplied) {
        const settling = settleRetried([{ write, error }], NONE_ACKNOWLEDGED)
        const settlement = await settledBeforeWindowEnds(settling, deadline, deps.shutdownSignal)
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
    }
  }
}
