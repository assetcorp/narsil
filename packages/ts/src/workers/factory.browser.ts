import { ErrorCodes, NarsilError } from '../errors'
import { detectRuntime } from '../runtime/detect'
import { resolveWorkerEntry } from './entry-point'
import type { Executor } from './executor'
import type { WorkerFactory } from './pool'
import { createWorkerExecutor, type WorkerLike } from './worker-executor'

declare const Worker: {
  new (url: string | URL, options?: { type?: string }): WorkerLike
}

export async function requireWorkerEntry(): Promise<string> {
  const entry = resolveWorkerEntry(import.meta.url, /\/src\/workers\/[^/]+$/, 'workers/entry.mjs')
  if (entry !== null) return entry
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `The engine finds no worker entry beside its own module at "${import.meta.url}", which is what happens where a bundler folds @delali/narsil into an application bundle. Keep @delali/narsil outside the bundle, or set workers.enabled to false`,
    { moduleUrl: import.meta.url },
  )
}

export async function createWorkerFactory(entryPoint?: string): Promise<WorkerFactory> {
  const runtime = detectRuntime()
  const resolvedEntry = entryPoint ?? (await requireWorkerEntry())

  if (runtime.supportsWebWorkers) {
    return function webFactory(_workerId: number, onDeath?: (error: Error) => void, onGone?: () => void): Executor {
      const instance = new Worker(resolvedEntry, { type: 'module' })
      return createWorkerExecutor(instance as unknown as WorkerLike, { onDeath, onGone })
    }
  }

  throw new NarsilError(ErrorCodes.WORKER_CRASHED, `No worker support available on runtime "${runtime.runtime}"`)
}
