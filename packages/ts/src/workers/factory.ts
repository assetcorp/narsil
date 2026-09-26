import { ErrorCodes, NarsilError } from '../errors'
import { detectRuntime } from '../runtime/detect'
import { missingWorkerEntry, resolveWorkerEntry } from './entry-point'
import type { Executor } from './executor'
import type { WorkerFactory } from './pool'
import { workerResourceLimits } from './resource-limits'
import { createWorkerExecutor, type WorkerLike } from './worker-executor'

declare const Worker: {
  new (url: string | URL, options?: { type?: string }): WorkerLike
}

async function entryFileExists(entry: string): Promise<boolean> {
  if (!entry.startsWith('file:')) return true
  const [{ access }, { fileURLToPath }] = await Promise.all([import('node:fs/promises'), import('node:url')])
  try {
    await access(fileURLToPath(entry))
    return true
  } catch {
    return false
  }
}

export async function requireWorkerEntry(): Promise<string> {
  const entry = resolveWorkerEntry(import.meta.url, /\/src\/workers\/[^/]+$/, 'workers/entry.mjs')
  if (entry === null) throw missingWorkerEntry(import.meta.url)
  if (import.meta.url.includes('/dist/') && !(await entryFileExists(entry))) throw missingWorkerEntry(import.meta.url)
  return entry
}

export async function createWorkerFactory(entryPoint?: string): Promise<WorkerFactory> {
  const runtime = detectRuntime()
  const resolvedEntry = entryPoint ?? (await requireWorkerEntry())

  if (runtime.supportsWorkerThreads) {
    const workerThreadsModule = await import('node:worker_threads')

    return function nodeFactory(workerId: number, onDeath?: (error: Error) => void, onGone?: () => void): Executor {
      const instance = new workerThreadsModule.Worker(new URL(resolvedEntry), {
        resourceLimits: workerResourceLimits(),
        workerData: { workerId },
      })
      return createWorkerExecutor(instance as unknown as WorkerLike, { onDeath, onGone })
    }
  }

  if (runtime.supportsWebWorkers) {
    return function webFactory(_workerId: number, onDeath?: (error: Error) => void, onGone?: () => void): Executor {
      const instance = new Worker(resolvedEntry, { type: 'module' })
      return createWorkerExecutor(instance as unknown as WorkerLike, { onDeath, onGone })
    }
  }

  throw new NarsilError(ErrorCodes.WORKER_CRASHED, `No worker support available on runtime "${runtime.runtime}"`)
}
