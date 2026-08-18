import { spawnNodeWorker } from '#platform/node-worker'
import { detectRuntime } from '../../runtime/detect'

export interface WorkerHandle {
  postMessage(msg: unknown, transfer?: ArrayBuffer[] | unknown[]): void
  on?(event: string, handler: (...args: unknown[]) => void): void
  addEventListener?(event: string, handler: (...args: unknown[]) => void): void
  unref?(): void
  terminate(): void | Promise<void>
}

export function resolveWorkerEntryPoint(): string {
  const base = import.meta.url
  const distIndex = base.lastIndexOf('/dist/')
  if (distIndex !== -1) {
    return new URL('vector/search-worker.mjs', base.slice(0, distIndex + 6)).href
  }
  return base.replace(/\/src\/vector\/search-pool\/[^/]+$/, '/dist/vector/search-worker.mjs')
}

export async function spawnWorker(entryPoint: string): Promise<WorkerHandle | null> {
  const runtime = detectRuntime()

  if (runtime.supportsWorkerThreads) {
    try {
      return await spawnNodeWorker(new URL(entryPoint))
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

export function listen(worker: WorkerHandle, handler: (msg: unknown) => void): void {
  if (typeof worker.on === 'function') {
    worker.on('message', handler)
    return
  }
  worker.addEventListener?.('message', (event: unknown) => {
    handler((event as { data: unknown }).data)
  })
}

export function listenForFailure(worker: WorkerHandle, handler: (err: Error) => void): void {
  if (typeof worker.on === 'function') {
    worker.on('error', (err: unknown) => handler(err instanceof Error ? err : new Error(String(err))))
    worker.on('exit', () => handler(new Error('Vector search worker exited')))
    return
  }
  worker.addEventListener?.('error', () => handler(new Error('Vector search worker failed')))
}
