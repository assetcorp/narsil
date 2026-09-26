import { requireSearchBackendSettings } from '#platform/native-core'
import { requireWorkerEntry } from '#platform/worker-factory'
import { detectRuntime } from '../runtime/detect'
import type { NarsilConfig } from '../types/config'
import { workersEnabledByDefault } from './orchestration'

export async function requireRunnableEnvironment(config: NarsilConfig | undefined): Promise<void> {
  requireSearchBackendSettings()
  if (!(config?.workers?.enabled ?? workersEnabledByDefault())) return
  const runtime = detectRuntime()
  if (runtime.supportsWorkerThreads || runtime.supportsWebWorkers) await requireWorkerEntry()
}
