import { detectRuntime } from '../../runtime/detect'
import type { CheckpointWorkerMessage, CheckpointWorkerRequest } from './checkpoint-worker'

const CHECKPOINT_WORKER_TIMEOUT_MS = 600_000

interface WorkerHandle {
  postMessage(msg: unknown, transfer?: ArrayBuffer[]): void
  on(event: string, handler: (...args: unknown[]) => void): void
  terminate(): void | Promise<void>
}

let workerUsable = true
let failNextWorkerForTests = false

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
    return new workerThreads.Worker(new URL(resolveWorkerEntryPoint())) as unknown as WorkerHandle
  } catch {
    return null
  }
}

function runWorker(worker: WorkerHandle, request: CheckpointWorkerRequest): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false

    const timeoutId = setTimeout(
      () => settle(() => reject(new Error(`Checkpoint worker timed out after ${CHECKPOINT_WORKER_TIMEOUT_MS}ms`))),
      CHECKPOINT_WORKER_TIMEOUT_MS,
    )
    if (typeof (timeoutId as { unref?: () => void }).unref === 'function') {
      ;(timeoutId as { unref: () => void }).unref()
    }

    function settle(action: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      try {
        void worker.terminate()
      } catch {
        /* termination failure is non-critical; the timeout is already cleared */
      }
      action()
    }

    worker.on('message', (msg: unknown) => {
      const response = msg as CheckpointWorkerMessage
      if (response.type === 'success') {
        settle(() => resolve())
      } else {
        settle(() => reject(new Error(response.message)))
      }
    })

    worker.on('error', (err: unknown) => {
      settle(() => reject(err instanceof Error ? err : new Error('Checkpoint worker failed')))
    })

    try {
      worker.postMessage(request)
    } catch (err) {
      settle(() => reject(err instanceof Error ? err : new Error('Failed to post message to checkpoint worker')))
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
  const worker = await spawnWorker()
  if (worker === null) {
    workerUsable = false
    return false
  }
  try {
    await runWorker(worker, request)
    return true
  } catch {
    workerUsable = false
    return false
  }
}

export function resetCheckpointWorkerLatch(): void {
  workerUsable = true
  failNextWorkerForTests = false
}

export function __failNextCheckpointWorkerForTests(): void {
  failNextWorkerForTests = true
}
