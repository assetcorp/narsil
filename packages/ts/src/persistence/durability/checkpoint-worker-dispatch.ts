import { spawnNodeWorker } from '#platform/node-worker'
import { detectRuntime } from '../../runtime/detect'
import type { CheckpointWorkerMessage, CheckpointWorkerRequest } from './checkpoint-worker'
import { CHECKPOINT_TIMEOUT_RECOVERY_BACKOFF_MS, CHECKPOINT_WORKER_TIMEOUT_MS } from './constants'
import type { SegmentedCheckpointOutcome } from './segment'

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

export interface WorkerRunOutcome {
  written: SegmentedCheckpointOutcome | null
  timedOut: boolean
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    ;(timer as { unref: () => void }).unref()
  }
  return timer
}

export function runWorker(worker: WorkerHandle, request: CheckpointWorkerRequest): Promise<WorkerRunOutcome> {
  return new Promise<WorkerRunOutcome>(resolve => {
    let settled = false
    let timeoutId = armSilenceTimeout()

    function armSilenceTimeout(): ReturnType<typeof setTimeout> {
      return unrefTimer(setTimeout(() => settle({ written: null, timedOut: true }, true), CHECKPOINT_WORKER_TIMEOUT_MS))
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
    unrefTimer(setTimeout(resolve, ms))
  })
}

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
