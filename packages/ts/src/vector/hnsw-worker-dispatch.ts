import { detectRuntime } from '../runtime/detect'
import type { HNSWConfig, SerializedHNSWGraph } from './hnsw'
import type { HNSWBuildRequestBinary, HNSWWorkerMessage } from './hnsw-build-worker'

const BUILD_TIMEOUT_MS = 120_000

export interface WorkerBuildResult {
  ok: true
  graph: SerializedHNSWGraph
}

export interface WorkerBuildFailure {
  ok: false
  reason: 'no-workers' | 'build-error' | 'timeout' | 'spawn-error'
  message: string
}

export type WorkerBuildOutcome = WorkerBuildResult | WorkerBuildFailure

interface WorkerHandle {
  postMessage(msg: unknown, transfer?: ArrayBuffer[] | unknown[]): void
  on?(event: string, handler: (...args: unknown[]) => void): void
  addEventListener?(event: string, handler: (...args: unknown[]) => void): void
  removeEventListener?(event: string, handler: (...args: unknown[]) => void): void
  terminate(): void | Promise<void>
}

function resolveWorkerEntryPoint(): string {
  const base = import.meta.url
  const distIndex = base.lastIndexOf('/dist/')
  if (distIndex !== -1) {
    return new URL('vector/hnsw-build-worker.mjs', base.slice(0, distIndex + 6)).href
  }
  return base.replace(/\/src\/vector\/[^/]+$/, '/dist/vector/hnsw-build-worker.mjs')
}

async function spawnWorker(): Promise<WorkerHandle | null> {
  const runtime = detectRuntime()
  const entryPoint = resolveWorkerEntryPoint()

  if (runtime.supportsWorkerThreads) {
    try {
      const workerThreads = await import('node:worker_threads')
      const instance = new workerThreads.Worker(new URL(entryPoint))
      return instance as unknown as WorkerHandle
    } catch {
      return null
    }
  }

  if (runtime.supportsWebWorkers) {
    try {
      const WorkerCtor = (globalThis as Record<string, unknown>).Worker as
        | (new (
            url: string | URL,
            options?: { type?: string },
          ) => WorkerHandle)
        | undefined

      if (typeof WorkerCtor !== 'function') return null
      return new WorkerCtor(entryPoint, { type: 'module' })
    } catch {
      return null
    }
  }

  return null
}

function listenForMessage(worker: WorkerHandle, handler: (msg: unknown) => void): () => void {
  if (typeof worker.on === 'function') {
    worker.on('message', handler)
    return () => {}
  }

  if (typeof worker.addEventListener === 'function') {
    const wrappedHandler = (event: unknown) => {
      handler((event as { data: unknown }).data)
    }
    worker.addEventListener('message', wrappedHandler)
    return () => {
      worker.removeEventListener?.('message', wrappedHandler)
    }
  }

  return () => {}
}

export async function dispatchWorkerBuild(
  docIds: string[],
  vectorData: Float32Array,
  dimension: number,
  config: HNSWConfig,
  timeoutMs?: number,
): Promise<WorkerBuildOutcome> {
  let worker: WorkerHandle | null
  try {
    worker = await spawnWorker()
  } catch {
    return {
      ok: false,
      reason: 'spawn-error',
      message: 'Failed to spawn HNSW build worker',
    }
  }

  if (worker === null) {
    return {
      ok: false,
      reason: 'no-workers',
      message: 'No worker thread support available in the current runtime',
    }
  }

  const effectiveTimeout = timeoutMs ?? BUILD_TIMEOUT_MS

  const transferCopy = new Float32Array(vectorData.length)
  transferCopy.set(vectorData)

  const request: HNSWBuildRequestBinary = {
    type: 'build-binary',
    docIds,
    vectorData: transferCopy,
    dimension,
    config,
  }

  return new Promise<WorkerBuildOutcome>(resolve => {
    let settled = false

    const timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        ok: false,
        reason: 'timeout',
        message: `HNSW build timed out after ${effectiveTimeout}ms`,
      })
    }, effectiveTimeout)

    function cleanup() {
      clearTimeout(timeoutId)
      removeListener()
      try {
        worker?.terminate()
      } catch {
        /* termination failure is non-critical */
      }
    }

    function handleMessage(msg: unknown) {
      if (settled) return

      const response = msg as HNSWWorkerMessage
      if (response.type === 'success') {
        settled = true
        cleanup()
        resolve({ ok: true, graph: response.graph })
        return
      }

      if (response.type === 'error') {
        settled = true
        cleanup()
        resolve({
          ok: false,
          reason: 'build-error',
          message: response.message,
        })
      }
    }

    const removeListener = listenForMessage(worker, handleMessage)

    try {
      worker.postMessage(request, [transferCopy.buffer])
    } catch (err) {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        ok: false,
        reason: 'spawn-error',
        message: err instanceof Error ? err.message : 'Failed to post message to worker',
      })
    }
  })
}

let workersAvailable: boolean | null = null

export async function probeWorkerAvailability(): Promise<boolean> {
  if (workersAvailable !== null) return workersAvailable

  const runtime = detectRuntime()
  workersAvailable = runtime.supportsWorkerThreads || runtime.supportsWebWorkers
  return workersAvailable
}

export function resetWorkerAvailabilityCache(): void {
  workersAvailable = null
}
