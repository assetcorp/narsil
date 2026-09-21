import { ErrorCodes, NarsilError } from '../errors'
import {
  CONSECUTIVE_TIMEOUTS_BEFORE_DEATH,
  DEFAULT_BACKPRESSURE_LIMIT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
} from './constants'
import type { Executor } from './executor'
import type { WorkerAction, WorkerResponse } from './protocol'
import { createRequestId, isValidWorkerResponse } from './protocol'

export interface WorkerExecutorConfig {
  backpressureLimit?: number
  requestTimeout?: number
  onDeath?: (error: Error) => void
  onGone?: () => void
}

export interface WorkerLike {
  postMessage(msg: unknown, transfer?: object[]): void
  terminate?(): unknown
  unref?(): void
  on?(event: string, handler: (...args: unknown[]) => void): void
  addEventListener?(event: string, handler: (...args: unknown[]) => void): void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timeoutId: ReturnType<typeof setTimeout> | undefined
}

function errorFromEventLike(event: unknown): Error {
  if (event instanceof Error) {
    return event
  }
  if (typeof event === 'object' && event !== null) {
    const detail = event as { error?: unknown; message?: unknown }
    if (detail.error instanceof Error) {
      return detail.error
    }
    if (typeof detail.message === 'string' && detail.message.length > 0) {
      return new Error(detail.message)
    }
  }
  return new Error('The worker reported an error event carrying no detail')
}

export function createWorkerExecutor(worker: WorkerLike, config?: WorkerExecutorConfig): Executor {
  const backpressureLimit = config?.backpressureLimit ?? DEFAULT_BACKPRESSURE_LIMIT
  const requestTimeout = config?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS
  const pending = new Map<string, PendingRequest>()
  let deathError: NarsilError | null = null
  let shutdownRequested = false
  let consecutiveTimeouts = 0
  let gone = false
  const waitingForTheThreadToGo: Array<() => void> = []
  const reportsItsExit = typeof worker.on === 'function'

  function processResponse(msg: unknown) {
    if (!isValidWorkerResponse(msg)) {
      return
    }

    consecutiveTimeouts = 0
    const response = msg as WorkerResponse
    const entry = pending.get(response.requestId)
    if (!entry) {
      return
    }

    clearTimeout(entry.timeoutId)
    pending.delete(response.requestId)

    if (response.type === 'error') {
      entry.reject(new NarsilError(response.code as never, response.message))
    } else {
      entry.resolve(response.data)
    }
  }

  function handleDeath(cause: unknown): void {
    if (deathError !== null) {
      return
    }
    const message = cause instanceof Error ? cause.message : String(cause)
    deathError = new NarsilError(ErrorCodes.WORKER_CRASHED, `Worker died: ${message}`)
    for (const [id, entry] of pending) {
      clearTimeout(entry.timeoutId)
      entry.reject(deathError)
      pending.delete(id)
    }
    if (!shutdownRequested) {
      config?.onDeath?.(cause instanceof Error ? cause : new Error(message))
    }
  }

  function reportGone(): void {
    if (gone) {
      return
    }
    gone = true
    for (const resume of waitingForTheThreadToGo.splice(0)) resume()
    config?.onGone?.()
  }

  function threadGoneWithin(timeoutMs: number): Promise<boolean> {
    if (gone) return Promise.resolve(true)
    return new Promise<boolean>(resolve => {
      const timeoutId = setTimeout(() => resolve(false), timeoutMs)
      waitingForTheThreadToGo.push(() => {
        clearTimeout(timeoutId)
        resolve(true)
      })
    })
  }

  function stopTheThread(): void {
    try {
      const stopping = worker.terminate?.()
      if (stopping instanceof Promise) stopping.catch(() => undefined)
    } catch {}
  }

  function stopAWorkerThatReportsNoExit(): void {
    stopTheThread()
    reportGone()
  }

  function askTheThreadToLeave(requestId: string): void {
    try {
      worker.postMessage({ type: 'shutdown', requestId } satisfies WorkerAction)
    } catch {}
  }

  function retireUnansweringWorker(cause: Error): void {
    handleDeath(cause)
    if (reportsItsExit) {
      askTheThreadToLeave(createRequestId())
      return
    }
    stopAWorkerThatReportsNoExit()
  }

  if (typeof worker.on === 'function') {
    worker.on('message', (msg: unknown) => processResponse(msg))
    worker.on('error', (cause: unknown) => {
      handleDeath(cause)
      reportGone()
    })
    worker.on('exit', (code: unknown) => {
      handleDeath(new Error(`Worker exited with code ${String(code)}`))
      reportGone()
    })
  } else if (typeof worker.addEventListener === 'function') {
    worker.addEventListener('message', (event: unknown) => {
      const msg = (event as { data: unknown }).data
      processResponse(msg)
    })
    worker.addEventListener('error', (event: unknown) => {
      handleDeath(errorFromEventLike(event))
      reportGone()
    })
  }

  function declareTimedOut(requestId: string, entry: PendingRequest): void {
    if (pending.get(requestId) !== entry) return
    pending.delete(requestId)
    entry.reject(new NarsilError(ErrorCodes.WORKER_TIMEOUT, `Request ${requestId} timed out after ${requestTimeout}ms`))
    consecutiveTimeouts += 1
    if (consecutiveTimeouts >= CONSECUTIVE_TIMEOUTS_BEFORE_DEATH) {
      retireUnansweringWorker(new Error(`no answer to ${CONSECUTIVE_TIMEOUTS_BEFORE_DEATH} consecutive requests`))
    }
  }

  function execute<T>(action: WorkerAction, transfer?: object[]): Promise<T> {
    if (deathError !== null) {
      return Promise.reject(deathError)
    }
    if (pending.size >= backpressureLimit) {
      return Promise.reject(
        new NarsilError(ErrorCodes.WORKER_BUSY, `Backpressure limit of ${backpressureLimit} pending requests reached`),
      )
    }

    const requestId = createRequestId()
    const taggedAction = { ...action, requestId }

    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutId: setTimeout(() => {
          entry.timeoutId = setTimeout(() => declareTimedOut(requestId, entry), 0)
        }, requestTimeout),
      }
      pending.set(requestId, entry)

      if (transfer === undefined) worker.postMessage(taggedAction)
      else worker.postMessage(taggedAction, transfer)
    })
  }

  function stopOnceTheWorkerAcknowledges(): void {
    const requestId = createRequestId()
    const stop = () => {
      pending.delete(requestId)
      if (!reportsItsExit) stopAWorkerThatReportsNoExit()
    }
    pending.set(requestId, { resolve: stop, reject: () => undefined, timeoutId: undefined })
    askTheThreadToLeave(requestId)
  }

  async function shutdown(): Promise<void> {
    shutdownRequested = true
    if (deathError === null && !gone) stopOnceTheWorkerAcknowledges()
    try {
      if (await threadGoneWithin(SHUTDOWN_TIMEOUT_MS)) return
      if (!reportsItsExit) {
        stopAWorkerThatReportsNoExit()
        return
      }
      worker.unref?.()
      throw new NarsilError(ErrorCodes.WORKER_TIMEOUT, 'Shutdown timed out')
    } finally {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timeoutId)
        entry.reject(new NarsilError(ErrorCodes.WORKER_CRASHED, 'Worker is shutting down'))
        pending.delete(id)
      }
    }
  }

  return { execute, shutdown }
}
