import {
  createRequestId,
  DEFAULT_BACKPRESSURE_LIMIT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  ErrorCodes,
  isValidWorkerResponse,
  NarsilError,
  SHUTDOWN_TIMEOUT_MS,
  WORKER_SILENCE_BEFORE_DEATH_MS,
  WORKER_SILENCE_BEFORE_PROBE_MS,
} from '#platform/worker-copies-host'
import type { Executor } from './executor'
import type { WorkerAction, WorkerResponse } from './protocol'

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
  const retained = new Map<string, () => void>()
  const unanswered = new Set<string>()
  let deathError: NarsilError | null = null
  let shutdownRequested = false
  let gone = false
  let lastSignOfLife = performance.now()
  let probeId: string | null = null
  let silenceCheck: ReturnType<typeof setTimeout> | undefined
  let askedToLeave = false
  let answeredSinceAskedToLeave = false
  const waitingForTheThreadToGo: Array<() => void> = []
  const reportsItsExit = typeof worker.on === 'function'

  function watchingSilence(): boolean {
    if (gone) return false
    if (askedToLeave) return true
    if (deathError !== null || shutdownRequested) return false
    return reportsItsExit || unanswered.size > 0
  }

  function stopWatchingSilence(): void {
    clearTimeout(silenceCheck)
    silenceCheck = undefined
  }

  function silenceBeforeStopping(): number {
    return askedToLeave && deathError !== null && !answeredSinceAskedToLeave
      ? WORKER_SILENCE_BEFORE_PROBE_MS
      : WORKER_SILENCE_BEFORE_DEATH_MS
  }

  function watchSilence(): void {
    if (silenceCheck !== undefined || !watchingSilence()) return
    const allowedSilence = probeId === null ? WORKER_SILENCE_BEFORE_PROBE_MS : silenceBeforeStopping()
    const timer = setTimeout(
      () => {
        const afterQueuedAnswers = setTimeout(checkSilence, 0)
        if (typeof afterQueuedAnswers.unref === 'function') afterQueuedAnswers.unref()
        silenceCheck = afterQueuedAnswers
      },
      Math.max(0, lastSignOfLife + allowedSilence - performance.now()),
    )
    if (typeof timer.unref === 'function') timer.unref()
    silenceCheck = timer
  }

  function probe(): void {
    const requestId = createRequestId()
    probeId = requestId
    try {
      worker.postMessage({ type: 'probe', requestId } satisfies WorkerAction)
    } catch {}
  }

  function checkSilence(): void {
    silenceCheck = undefined
    if (!watchingSilence()) return
    const silentFor = performance.now() - lastSignOfLife
    if (silentFor >= silenceBeforeStopping()) {
      if (askedToLeave) stopTheThread()
      else retireUnansweringWorker(new Error(`no answer to any request or probe for ${Math.round(silentFor)}ms`))
      return
    }
    if (probeId === null && silentFor >= WORKER_SILENCE_BEFORE_PROBE_MS) probe()
    watchSilence()
  }

  function noteAnswer(requestId: string): void {
    lastSignOfLife = performance.now()
    unanswered.delete(requestId)
    const probeAnswered = requestId === probeId
    if (probeAnswered) probeId = null
    const firstAnswerSinceAskedToLeave = askedToLeave && !answeredSinceAskedToLeave
    if (askedToLeave) answeredSinceAskedToLeave = true
    if (!watchingSilence()) {
      stopWatchingSilence()
      return
    }
    if (!probeAnswered && !firstAnswerSinceAskedToLeave) return
    stopWatchingSilence()
    watchSilence()
  }

  function processResponse(msg: unknown) {
    if (!isValidWorkerResponse(msg)) {
      return
    }

    const response = msg as WorkerResponse
    noteAnswer(response.requestId)
    retained.get(response.requestId)?.()
    retained.delete(response.requestId)
    const entry = pending.get(response.requestId)
    if (!entry) {
      return
    }

    clearTimeout(entry.timeoutId)
    pending.delete(response.requestId)

    if (response.type === 'error') {
      entry.reject(new NarsilError(response.code as never, response.message, response.details))
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
    stopWatchingSilence()
    unanswered.clear()
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
    stopWatchingSilence()
    for (const release of retained.values()) release()
    retained.clear()
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

  function watchTheThreadLeave(): void {
    if (!reportsItsExit || gone || askedToLeave) return
    askedToLeave = true
    lastSignOfLife = performance.now()
    stopWatchingSilence()
    probe()
    watchSilence()
  }

  function retireUnansweringWorker(cause: Error): void {
    handleDeath(cause)
    if (!reportsItsExit) {
      stopAWorkerThatReportsNoExit()
      return
    }
    askTheThreadToLeave(createRequestId())
    watchTheThreadLeave()
  }

  if (typeof worker.on === 'function') {
    worker.on('message', (msg: unknown) => processResponse(msg))
    worker.on('error', (cause: unknown) => {
      handleDeath(cause)
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
      stopAWorkerThatReportsNoExit()
    })
  }

  function declareTimedOut(requestId: string, entry: PendingRequest): void {
    if (pending.get(requestId) !== entry) return
    pending.delete(requestId)
    entry.reject(new NarsilError(ErrorCodes.WORKER_TIMEOUT, `Request ${requestId} timed out after ${requestTimeout}ms`))
  }

  function send<T>(
    action: WorkerAction,
    transfer: object[] | undefined,
    settled: (() => void) | undefined,
    bounded: boolean,
  ): Promise<T> {
    if (deathError !== null) {
      settled?.()
      return Promise.reject(deathError)
    }
    if (bounded && pending.size >= backpressureLimit) {
      settled?.()
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
        timeoutId: bounded
          ? setTimeout(() => {
              entry.timeoutId = setTimeout(() => declareTimedOut(requestId, entry), 0)
            }, requestTimeout)
          : undefined,
      }
      pending.set(requestId, entry)
      if (settled !== undefined) retained.set(requestId, settled)
      try {
        if (transfer === undefined) worker.postMessage(taggedAction)
        else worker.postMessage(taggedAction, transfer)
      } catch (error) {
        clearTimeout(entry.timeoutId)
        pending.delete(requestId)
        retained.delete(requestId)
        settled?.()
        reject(error)
        return
      }
      if (unanswered.size === 0 && probeId === null) lastSignOfLife = performance.now()
      unanswered.add(requestId)
      watchSilence()
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
    if (reportsItsExit) watchTheThreadLeave()
    else stopWatchingSilence()
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

  watchSilence()

  return {
    execute: (action, transfer) => send(action, transfer, undefined, true),
    executeUntilAnswered: (action, settled) => send(action, undefined, settled, false),
    shutdown,
  }
}
