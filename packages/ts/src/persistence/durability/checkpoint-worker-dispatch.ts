import { detectRuntime } from '../../runtime/detect'
import type { CheckpointWorkerMessage, CheckpointWorkerRequest } from './checkpoint-worker'

const CHECKPOINT_WORKER_TIMEOUT_MS = 600_000

const TIMEOUT_RECOVERY_BACKOFF_MS = 50

interface WorkerHandle {
  postMessage(msg: unknown, transfer?: ArrayBuffer[]): void
  on(event: string, handler: (...args: unknown[]) => void): void
  off(event: string, handler: (...args: unknown[]) => void): void
  unref?(): void
  terminate(): void | Promise<void>
}

let workerUsable = true
let failNextWorkerForTests = false
let pooledWorker: WorkerHandle | null = null
let workerBusy = false
let spawnedWorkerCount = 0

function resolveWorkerEntryPoint(): string {
  const base = import.meta.url
  const distIndex = base.lastIndexOf('/dist/')
  if (distIndex !== -1) {
    return new URL('persistence/durability/checkpoint-worker.mjs', base.slice(0, distIndex + 6)).href
  }
  return base.replace(/\/src\/persistence\/durability\/[^/]+$/, '/dist/persistence/durability/checkpoint-worker.mjs')
}

async function spawnWorker(): Promise<WorkerHandle | null> {
  try {
    const workerThreads = await import('node:worker_threads')
    const worker = new workerThreads.Worker(new URL(resolveWorkerEntryPoint())) as unknown as WorkerHandle
    if (typeof worker.unref === 'function') {
      worker.unref()
    }
    spawnedWorkerCount += 1
    return worker
  } catch {
    return null
  }
}

function discardWorker(worker: WorkerHandle): void {
  if (pooledWorker === worker) {
    pooledWorker = null
  }
  try {
    void worker.terminate()
  } catch {
    /* termination failure is non-critical; the handle is already dropped from the pool */
  }
}

interface WorkerRunOutcome {
  ok: boolean
  timedOut: boolean
}

function runWorker(worker: WorkerHandle, request: CheckpointWorkerRequest): Promise<WorkerRunOutcome> {
  return new Promise<WorkerRunOutcome>(resolve => {
    let settled = false

    const onMessage = (msg: unknown): void => {
      const response = msg as CheckpointWorkerMessage
      if (response.type === 'success') {
        settle({ ok: true, timedOut: false }, false)
      } else {
        settle({ ok: false, timedOut: false }, true)
      }
    }

    const onError = (): void => {
      settle({ ok: false, timedOut: false }, true)
    }

    const onExit = (): void => {
      settle({ ok: false, timedOut: false }, true)
    }

    const timeoutId = setTimeout(() => settle({ ok: false, timedOut: true }, true), CHECKPOINT_WORKER_TIMEOUT_MS)
    if (typeof (timeoutId as { unref?: () => void }).unref === 'function') {
      ;(timeoutId as { unref: () => void }).unref()
    }

    function settle(outcome: WorkerRunOutcome, discard: boolean): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeoutId)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
      if (discard) {
        discardWorker(worker)
      }
      resolve(outcome)
    }

    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', onExit)

    try {
      worker.postMessage(request)
    } catch {
      settle({ ok: false, timedOut: false }, true)
    }
  })
}

function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }
  })
}

export async function runCheckpointOnWorker(request: CheckpointWorkerRequest): Promise<boolean> {
  if (failNextWorkerForTests) {
    failNextWorkerForTests = false
    return false
  }
  const runtime = detectRuntime()
  if (!runtime.supportsWorkerThreads || !runtime.supportsFileSystem || !workerUsable) {
    return false
  }
  if (workerBusy) {
    return false
  }

  workerBusy = true
  try {
    if (pooledWorker === null) {
      pooledWorker = await spawnWorker()
    }
    const worker = pooledWorker
    if (worker === null) {
      workerUsable = false
      return false
    }

    const outcome = await runWorker(worker, request)
    if (outcome.ok) {
      return true
    }
    if (outcome.timedOut) {
      await delay(TIMEOUT_RECOVERY_BACKOFF_MS)
    }
    return false
  } finally {
    workerBusy = false
  }
}

export function resetCheckpointWorkerLatch(): void {
  workerUsable = true
  failNextWorkerForTests = false
  spawnedWorkerCount = 0
  terminateCheckpointWorker()
}

export function terminateCheckpointWorker(): void {
  const worker = pooledWorker
  if (worker === null) {
    return
  }
  pooledWorker = null
  try {
    void worker.terminate()
  } catch {
    /* termination failure is non-critical at shutdown; the handle is already dropped */
  }
}

export function __checkpointWorkerSpawnCountForTests(): number {
  return spawnedWorkerCount
}

export function __failNextCheckpointWorkerForTests(): void {
  failNextWorkerForTests = true
}
