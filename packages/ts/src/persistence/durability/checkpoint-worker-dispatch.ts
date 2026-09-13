import { spawnNodeWorker } from '#platform/node-worker'
import { detectRuntime } from '../../runtime/detect'
import type { CheckpointWorkerMessage, CheckpointWorkerRequest } from './checkpoint-worker'
import { CHECKPOINT_TIMEOUT_RECOVERY_BACKOFF_MS, CHECKPOINT_WORKER_TIMEOUT_MS } from './constants'
import type { SegmentedCheckpointOutcome } from './segment'

/**
 * A checkpoint runs on a thread reached through this, which a Node worker
 * satisfies.
 *
 * @internal
 */
export interface WorkerHandle {
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
    const worker = await spawnNodeWorker(new URL(resolveWorkerEntryPoint()))
    if (worker === null) {
      return null
    }
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
  } catch {}
}

/**
 * This is what one checkpoint on the worker came to: what it wrote, or null
 * with a flag telling a worker that fell silent apart from one that failed.
 *
 * @internal
 */
export interface WorkerRunOutcome {
  written: SegmentedCheckpointOutcome | null
  timedOut: boolean
}

function unreffed(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    ;(timer as { unref: () => void }).unref()
  }
  return timer
}

/**
 * Sends one checkpoint request to a worker and waits for its answer. The
 * worker posts a heartbeat while it works, and the wait gives up only once
 * the worker has stayed silent for the timeout, so a checkpoint that places a
 * large graph runs to the end while a hung worker still gets discarded.
 *
 * @param worker The worker to run the checkpoint on.
 * @param request The checkpoint to write.
 * @returns What the worker wrote, or null where it failed or fell silent.
 *
 * @internal
 */
export function runWorker(worker: WorkerHandle, request: CheckpointWorkerRequest): Promise<WorkerRunOutcome> {
  return new Promise<WorkerRunOutcome>(resolve => {
    let settled = false
    let timeoutId = armSilenceTimeout()

    function armSilenceTimeout(): ReturnType<typeof setTimeout> {
      return unreffed(setTimeout(() => settle({ written: null, timedOut: true }, true), CHECKPOINT_WORKER_TIMEOUT_MS))
    }

    const onMessage = (msg: unknown): void => {
      const response = msg as CheckpointWorkerMessage
      if (response.type === 'heartbeat') {
        clearTimeout(timeoutId)
        timeoutId = armSilenceTimeout()
        return
      }
      if (response.type === 'success') {
        settle({ written: response.outcome, timedOut: false }, false)
      } else {
        settle({ written: null, timedOut: false }, true)
      }
    }

    const onError = (): void => {
      settle({ written: null, timedOut: false }, true)
    }

    const onExit = (): void => {
      settle({ written: null, timedOut: false }, true)
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
      settle({ written: null, timedOut: false }, true)
    }
  })
}

function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    unreffed(setTimeout(resolve, ms))
  })
}

/**
 * Writes a checkpoint on the pooled worker thread and reports what it wrote.
 * It reports null where no worker could take the write, in which case the
 * caller writes the checkpoint in process.
 *
 * @internal
 */
export async function runCheckpointOnWorker(
  request: CheckpointWorkerRequest,
): Promise<SegmentedCheckpointOutcome | null> {
  if (failNextWorkerForTests) {
    failNextWorkerForTests = false
    return null
  }
  const runtime = detectRuntime()
  if (!runtime.supportsWorkerThreads || !runtime.supportsFileSystem || !workerUsable) {
    return null
  }
  if (workerBusy) {
    return null
  }

  workerBusy = true
  try {
    if (pooledWorker === null) {
      pooledWorker = await spawnWorker()
    }
    const worker = pooledWorker
    if (worker === null) {
      workerUsable = false
      return null
    }

    const outcome = await runWorker(worker, request)
    if (outcome.written !== null) {
      return outcome.written
    }
    if (outcome.timedOut) {
      await delay(CHECKPOINT_TIMEOUT_RECOVERY_BACKOFF_MS)
    }
    return null
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
  } catch {}
}

export function __checkpointWorkerSpawnCountForTests(): number {
  return spawnedWorkerCount
}

export function __failNextCheckpointWorkerForTests(): void {
  failNextWorkerForTests = true
}
