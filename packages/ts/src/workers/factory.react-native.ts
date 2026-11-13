import { ErrorCodes, NarsilError } from '../errors'
import { detectRuntime } from '../runtime/detect'
import type { WorkerFactory } from './pool'

function noWorkerSupport(): NarsilError {
  return new NarsilError(
    ErrorCodes.WORKER_CRASHED,
    `No worker support available on runtime "${detectRuntime().runtime}"`,
  )
}

export async function requireWorkerEntry(): Promise<string> {
  throw noWorkerSupport()
}

export async function createWorkerFactory(_entryPoint?: string): Promise<WorkerFactory> {
  throw noWorkerSupport()
}
