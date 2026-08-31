import { ErrorCodes, NarsilError } from '../errors'
import type { Executor } from './executor'
import type { WorkerAction, WorkerResponse } from './protocol'
import { createRequestId, isValidWorkerResponse } from './protocol'

export interface WorkerExecutorConfig {
  backpressureLimit?: number
  requestTimeout?: number
  onDeath?: (error: Error) => void
}

export interface WorkerLike {
  postMessage(msg: unknown): void
  on?(event: string, handler: (...args: unknown[]) => void): void
  addEventListener?(event: string, handler: (...args: unknown[]) => void): void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timeoutId: ReturnType<typeof setTimeout>
}

const DEFAULT_BACKPRESSURE_LIMIT = 100
const DEFAULT_REQUEST_TIMEOUT = 30_000
const SHUTDOWN_TIMEOUT = 5_000
const CONSECUTIVE_TIMEOUTS_BEFORE_DEATH = 3

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
  const requestTimeout = config?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT
  const pending = new Map<string, PendingRequest>()
  let deathError: NarsilError | null = null
  let shutdownRequested = false
  let consecutiveTimeouts = 0

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

  if (typeof worker.on === 'function') {
    worker.on('message', (msg: unknown) => processResponse(msg))
    worker.on('error', (cause: unknown) => handleDeath(cause))
    worker.on('exit', (code: unknown) => handleDeath(new Error(`Worker exited with code ${String(code)}`)))
  } else if (typeof worker.addEventListener === 'function') {
    worker.addEventListener('message', (event: unknown) => {
      const msg = (event as { data: unknown }).data
      processResponse(msg)
    })
    worker.addEventListener('error', (event: unknown) => handleDeath(errorFromEventLike(event)))
  }

  function execute<T>(action: WorkerAction): Promise<T> {
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
      const timeoutId = setTimeout(() => {
        pending.delete(requestId)
        reject(new NarsilError(ErrorCodes.WORKER_TIMEOUT, `Request ${requestId} timed out after ${requestTimeout}ms`))
        consecutiveTimeouts += 1
        if (consecutiveTimeouts >= CONSECUTIVE_TIMEOUTS_BEFORE_DEATH) {
          handleDeath(new Error(`no answer to ${CONSECUTIVE_TIMEOUTS_BEFORE_DEATH} consecutive requests`))
        }
      }, requestTimeout)

      pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutId,
      })

      worker.postMessage(taggedAction)
    })
  }

  async function shutdown(): Promise<void> {
    shutdownRequested = true
    if (deathError !== null) {
      return
    }
    const requestId = createRequestId()
    const shutdownAction: WorkerAction = { type: 'shutdown', requestId }

    const shutdownPromise = new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pending.delete(requestId)
        reject(new NarsilError(ErrorCodes.WORKER_TIMEOUT, 'Shutdown timed out'))
      }, SHUTDOWN_TIMEOUT)

      pending.set(requestId, {
        resolve: () => resolve(),
        reject,
        timeoutId,
      })

      worker.postMessage(shutdownAction)
    })

    try {
      await shutdownPromise
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
