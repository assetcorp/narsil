import { describeError, ErrorCodes, NarsilError } from '../../../errors'
import { PRIMARY_CHANGE_RETRY_WINDOW_MS } from '../constants'
import type { BatchWrite, WriteFailure } from './batch-write'

export const WINDOW_ENDED: unique symbol = Symbol('forward window ended')

export async function beforeWindowEnds<T>(
  work: Promise<T>,
  deadline: number,
  shutdownSignal?: AbortSignal,
): Promise<T | typeof WINDOW_ENDED> {
  work.catch(() => undefined)
  if (shutdownSignal?.aborted === true) return WINDOW_ENDED
  let timer: ReturnType<typeof setTimeout> | undefined
  const waiters = shutdownSignal === undefined ? undefined : shutdownWaitersOf(shutdownSignal)
  let wake: (() => void) | undefined
  const ended = new Promise<typeof WINDOW_ENDED>(resolve => {
    wake = () => resolve(WINDOW_ENDED)
    waiters?.add(wake)
    timer = setTimeout(wake, Math.max(0, deadline - Date.now()))
  })
  try {
    return await Promise.race([work, ended])
  } finally {
    clearTimeout(timer)
    if (wake !== undefined) waiters?.delete(wake)
  }
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

export function beforeShutdown<T>(
  work: Promise<T>,
  shutdownSignal: AbortSignal | undefined,
): Promise<T | typeof WINDOW_ENDED> {
  if (shutdownSignal === undefined) return work
  if (shutdownSignal.aborted) {
    work.catch(() => undefined)
    return Promise.resolve(WINDOW_ENDED)
  }
  const waiters = shutdownWaitersOf(shutdownSignal)
  return new Promise<T | typeof WINDOW_ENDED>((resolve, reject) => {
    const wake = (): void => resolve(WINDOW_ENDED)
    waiters.add(wake)
    work.then(
      value => {
        waiters.delete(wake)
        resolve(value)
      },
      error => {
        waiters.delete(wake)
        reject(error)
      },
    )
  })
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

export function requireOpenWindow(
  deadline: number,
  indexName: string,
  docId: string,
  shutdownSignal?: AbortSignal,
): void {
  if (windowClosed(deadline, shutdownSignal)) throw windowEndedOutcome(indexName, docId, shutdownSignal)
}

export function unsentAfterWindow<V>(
  indexName: string,
  writes: readonly BatchWrite<V>[],
  shutdownSignal?: AbortSignal,
): WriteFailure<V>[] {
  return writes.map(write => ({ write, error: windowEndedOutcome(indexName, write.docId, shutdownSignal) }))
}

export function interruptedOutcome(indexName: string, docId: string, error: unknown): NarsilError {
  return new NarsilError(
    ErrorCodes.REPLICATION_OUTCOME_UNKNOWN,
    `The connection to the primary of index '${indexName}' failed after this node forwarded the write to document '${docId}', so the write may or may not have taken effect. Read the document before you retry the write.`,
    { indexName, docId, reason: 'forward_interrupted', originalError: describeError(error) },
  )
}
