import { describeError, ErrorCodes, NarsilError } from '../../../errors'
import { PRIMARY_CHANGE_RETRY_WINDOW_MS } from '../constants'
import type { BatchWrite, WriteFailure } from './batch-write'

export const WINDOW_ENDED: unique symbol = Symbol('forward window ended')

export function beforeWindowEnds<T>(
  work: Promise<T>,
  deadline: number,
  shutdownSignal?: AbortSignal,
): Promise<T | typeof WINDOW_ENDED> {
  if (shutdownSignal?.aborted === true) {
    work.catch(() => undefined)
    return Promise.resolve(WINDOW_ENDED)
  }
  const waiters = shutdownSignal === undefined ? undefined : shutdownWaitersOf(shutdownSignal)
  return new Promise<T | typeof WINDOW_ENDED>((resolve, reject) => {
    const wake = (): void => {
      forget()
      resolve(WINDOW_ENDED)
    }
    const timer = setTimeout(wake, Math.max(0, deadline - Date.now()))
    const forget = (): void => {
      clearTimeout(timer)
      waiters?.delete(wake)
    }
    waiters?.add(wake)
    work.then(
      value => {
        forget()
        resolve(value)
      },
      error => {
        forget()
        reject(error)
      },
    )
  })
}

export async function pauseBeforeShutdown(delayMs: number, shutdownSignal?: AbortSignal): Promise<void> {
  await beforeWindowEnds(new Promise<never>(() => undefined), Date.now() + delayMs, shutdownSignal)
}

const waitersBySignal = new WeakMap<AbortSignal, Set<() => void>>()

function shutdownWaitersOf(shutdownSignal: AbortSignal): Set<() => void> {
  const known = waitersBySignal.get(shutdownSignal)
  if (known !== undefined) return known
  const waiters = new Set<() => void>()
  waitersBySignal.set(shutdownSignal, waiters)
  shutdownSignal.addEventListener(
    'abort',
    () => {
      for (const wake of waiters) wake()
      waiters.clear()
    },
    { once: true },
  )
  return waiters
}

const endedBeforeSending = new WeakSet<NarsilError>()

export function unsentWindowEndedOutcome(indexName: string, docId: string, shutdownSignal?: AbortSignal): NarsilError {
  const outcome = windowEndedOutcome(indexName, docId, shutdownSignal)
  endedBeforeSending.add(outcome)
  return outcome
}

export function windowEndedBeforeSending(error: unknown): boolean {
  return error instanceof NarsilError && endedBeforeSending.has(error)
}

export function windowEndedOutcome(indexName: string, docId: string, shutdownSignal?: AbortSignal): NarsilError {
  const cause =
    shutdownSignal?.aborted === true
      ? 'once it began to shut down'
      : `once ${PRIMARY_CHANGE_RETRY_WINDOW_MS}ms had passed`
  return new NarsilError(
    ErrorCodes.REPLICATION_OUTCOME_UNKNOWN,
    `This node stopped waiting for the primary of index '${indexName}' to answer the write to document '${docId}' ${cause}, so the write may or may not have taken effect. Read the document before you retry the write.`,
    { indexName, docId, reason: 'forward_window_ended' },
  )
}

export function windowClosed(deadline: number, shutdownSignal?: AbortSignal): boolean {
  return Date.now() >= deadline || shutdownSignal?.aborted === true
}

export interface AttemptWindow {
  readonly deadline: number
  started: boolean
  closed: boolean
  ending: Set<() => void> | undefined
}

export function openAttemptWindow(deadline: number): AttemptWindow {
  return { deadline, started: false, closed: false, ending: undefined }
}

export function attemptWindowClosed(window: AttemptWindow, shutdownSignal?: AbortSignal): boolean {
  return window.closed || windowClosed(window.deadline, shutdownSignal)
}

export function beforeAttemptEnds<T>(
  work: Promise<T>,
  window: AttemptWindow,
  shutdownSignal?: AbortSignal,
): Promise<T | typeof WINDOW_ENDED> {
  if (window.closed || shutdownSignal?.aborted === true) {
    work.catch(() => undefined)
    return Promise.resolve(WINDOW_ENDED)
  }
  const shutdownWaiters = shutdownSignal === undefined ? undefined : shutdownWaitersOf(shutdownSignal)
  window.ending ??= new Set()
  const ending = window.ending
  return new Promise<T | typeof WINDOW_ENDED>((resolve, reject) => {
    const wake = (): void => resolve(WINDOW_ENDED)
    const forget = (): void => {
      ending.delete(wake)
      shutdownWaiters?.delete(wake)
    }
    ending.add(wake)
    shutdownWaiters?.add(wake)
    work.then(
      value => {
        forget()
        resolve(value)
      },
      error => {
        forget()
        reject(error)
      },
    )
  })
}

export function requireOpenWindow(
  window: AttemptWindow,
  indexName: string,
  docId: string,
  shutdownSignal?: AbortSignal,
): void {
  if (attemptWindowClosed(window, shutdownSignal)) throw unsentWindowEndedOutcome(indexName, docId, shutdownSignal)
}

export function startWithinWindow(
  window: AttemptWindow,
  indexName: string,
  docId: string,
  shutdownSignal?: AbortSignal,
): void {
  requireOpenWindow(window, indexName, docId, shutdownSignal)
  window.started = true
}

export async function startedBeforeWindowEnds<T>(
  attempt: Promise<T>,
  window: AttemptWindow,
  shutdownSignal?: AbortSignal,
): Promise<T | typeof WINDOW_ENDED> {
  const answer = await beforeWindowEnds(attempt, window.deadline, shutdownSignal)
  if (answer !== WINDOW_ENDED) return answer
  window.closed = true
  if (!window.started) return WINDOW_ENDED
  if (window.ending !== undefined) for (const wake of window.ending) wake()
  return attempt
}

export function unsentAfterWindow<V>(
  indexName: string,
  writes: readonly BatchWrite<V>[],
  shutdownSignal?: AbortSignal,
): WriteFailure<V>[] {
  return writes.map(write => ({ write, error: unsentWindowEndedOutcome(indexName, write.docId, shutdownSignal) }))
}

export function interruptedOutcome(indexName: string, docId: string, error: unknown): NarsilError {
  return new NarsilError(
    ErrorCodes.REPLICATION_OUTCOME_UNKNOWN,
    `The connection to the primary of index '${indexName}' failed after this node forwarded the write to document '${docId}', so the write may or may not have taken effect. Read the document before you retry the write.`,
    { indexName, docId, reason: 'forward_interrupted', originalError: describeError(error) },
  )
}
