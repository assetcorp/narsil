import { ErrorCodes, NarsilError } from '../errors'
import type { Executor } from './executor'
import type { WorkerAction, WorkerResponse } from './protocol'
import { createRequestId, isValidWorkerResponse } from './protocol'

export interface WorkerExecutorConfig {
  backpressureLimit?: number
  requestTimeout?: number
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

export function createWorkerExecutor(worker: WorkerLike, config?: WorkerExecutorConfig): Executor {
  const backpressureLimit = config?.backpressureLimit ?? DEFAULT_BACKPRESSURE_LIMIT
  const requestTimeout = config?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT
  const pending = new Map<string, PendingRequest>()

  function processResponse(msg: unknown) {
    if (!isValidWorkerResponse(msg)) {
      return
    }

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

  if (typeof worker.on === 'function') {
    worker.on('message', (msg: unknown) => processResponse(msg))
  } else if (typeof worker.addEventListener === 'function') {
    worker.addEventListener('message', (event: unknown) => {
      const msg = (event as { data: unknown }).data
      processResponse(msg)
    })
  }

  function execute<T>(action: WorkerAction): Promise<T> {
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
