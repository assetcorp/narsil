import { detectRuntime } from '../../runtime/detect'
import type { createWorkerOrchestrator as create } from './index'
import { createLocalOrchestrator } from './local'
import type { WorkerOrchestrator } from './types'

export function workersEnabledByDefault(): boolean {
  return detectRuntime().runtime !== 'browser'
}

export async function createWorkerOrchestrator(...args: Parameters<typeof create>): Promise<WorkerOrchestrator> {
  const [config, , indexes] = args
  if (!(config?.workers?.enabled ?? workersEnabledByDefault())) return createLocalOrchestrator(config, indexes)
  return (await import('./index')).createWorkerOrchestrator(...args)
}
