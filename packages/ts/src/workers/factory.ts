import { ErrorCodes, NarsilError } from '../errors'
import { detectRuntime } from '../runtime/detect'
import type { Executor } from './executor'
import type { WorkerFactory } from './pool'
import { createWorkerExecutor, type WorkerLike } from './worker-executor'

declare const Worker: {
  new (url: string | URL, options?: { type?: string }): WorkerLike
}

function resolveEntryPoint(): string {
  const base = import.meta.url
  if (base.endsWith('.mjs') || base.endsWith('.js')) {
    return new URL('./workers/entry.mjs', base).href
  }
  return base.replace(/\/src\/workers\/[^/]+$/, '/dist/workers/entry.mjs')
}

export async function createWorkerFactory(entryPoint?: string): Promise<WorkerFactory> {
  const runtime = detectRuntime()
  const resolvedEntry = entryPoint ?? resolveEntryPoint()

  if (runtime.supportsWorkerThreads) {
    const workerThreadsModule = await import('node:worker_threads')

    return function nodeFactory(_workerId: number): Executor {
      const instance = new workerThreadsModule.Worker(new URL(resolvedEntry))
      return createWorkerExecutor(instance as unknown as WorkerLike)
    }
  }

  if (runtime.supportsWebWorkers) {
    return function webFactory(_workerId: number): Executor {
      const instance = new Worker(resolvedEntry, { type: 'module' })
      return createWorkerExecutor(instance as unknown as WorkerLike)
    }
  }

  throw new NarsilError(ErrorCodes.WORKER_CRASHED, `No worker support available on runtime "${runtime.runtime}"`)
}
