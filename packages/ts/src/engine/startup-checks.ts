import { requireSearchBackendSettings } from '#platform/native-core'
import { requireWorkerEntry } from '#platform/worker-factory'
import { ErrorCodes, NarsilError } from '../errors'
import { detectRuntime } from '../runtime/detect'
import type { NarsilConfig } from '../types/config'
import { workersEnabledByDefault } from './orchestration'

let announcedMissingWorkerEntry = false

function withoutWorkers(config: NarsilConfig | undefined, reason: NarsilError): NarsilConfig {
  if (!announcedMissingWorkerEntry) {
    announcedMissingWorkerEntry = true
    console.warn(
      `Narsil answers every query on this thread, because it finds no worker entry beside its own module at "${String(reason.details.moduleUrl)}", which happens where a bundler folds @delali/narsil into an application bundle. Keep @delali/narsil outside the bundle to use worker threads, or set workers.enabled to false to silence this notice.`,
    )
  }
  return { ...config, workers: { ...config?.workers, enabled: false } }
}

export async function resolveRunnableConfig(config: NarsilConfig | undefined): Promise<NarsilConfig | undefined> {
  requireSearchBackendSettings()
  if (!(config?.workers?.enabled ?? workersEnabledByDefault())) return config
  const runtime = detectRuntime()
  if (!runtime.supportsWorkerThreads && !runtime.supportsWebWorkers) return config
  try {
    await requireWorkerEntry()
    return config
  } catch (err) {
    const missingEntry = err instanceof NarsilError && err.code === ErrorCodes.CONFIG_INVALID
    if (!missingEntry || config?.workers?.enabled === true) throw err
    return withoutWorkers(config, err)
  }
}
