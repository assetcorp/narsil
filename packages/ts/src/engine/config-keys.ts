import { ErrorCodes, NarsilError } from '../errors'
import type {
  AnalysisConfig,
  DurabilityConfig,
  IndexLifecycleConfig,
  NarsilConfig,
  WorkerConfig,
} from '../types/config'

const NARSIL_CONFIG_KEYS: Record<keyof NarsilConfig, true> = {
  persistence: true,
  invalidation: true,
  plugins: true,
  idGenerator: true,
  workers: true,
  embedding: true,
  embeddingAdapters: true,
  durability: true,
  analysis: true,
  lifecycle: true,
}

const DURABILITY_CONFIG_KEYS: Record<keyof DurabilityConfig, true> = {
  tier: true,
  directory: true,
  mode: true,
  flushIntervalMs: true,
  segmentMaxBytes: true,
  checkpointIntervalMs: true,
  checkpointMutationThreshold: true,
  compactionThreshold: true,
}

const WORKER_CONFIG_KEYS: Record<keyof WorkerConfig, true> = {
  enabled: true,
  count: true,
  promotionThreshold: true,
  idleTimeoutMs: true,
  mainCopyQueries: true,
  bootstrapModule: true,
}

const LIFECYCLE_CONFIG_KEYS: Record<keyof IndexLifecycleConfig, true> = {
  idleTimeoutMs: true,
  maxOpenIndexes: true,
  maxOpenBytes: true,
  maxReopenWaiters: true,
}

const ANALYSIS_CONFIG_KEYS: Record<keyof AnalysisConfig, true> = {
  rebuild: true,
  onStaleAnalysis: true,
}

function requireKnownKeys(section: string, value: unknown, known: Record<string, true>): void {
  if (value === undefined || value === null || typeof value !== 'object') return
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(known, key)) continue
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `The configuration sets "${section}${key}", which is no setting that createNarsil accepts. The settings at that level are ${Object.keys(known).join(', ')}`,
      { setting: `${section}${key}`, settings: Object.keys(known) },
    )
  }
}

function requireNamedPlugins(plugins: unknown): void {
  if (plugins === undefined) return
  if (!Array.isArray(plugins)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The configuration sets "plugins" to something other than a list')
  }
  plugins.forEach((plugin: unknown, position: number) => {
    const name = (plugin as { name?: unknown } | null)?.name
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        `The plugin at position ${position} carries no name, and the engine names each plugin in its errors and event payloads`,
        { position },
      )
    }
  })
}

export function requireKnownConfig(config: NarsilConfig | undefined): void {
  if (config === undefined) return
  requireKnownKeys('', config, NARSIL_CONFIG_KEYS)
  requireKnownKeys('durability.', config.durability, DURABILITY_CONFIG_KEYS)
  requireKnownKeys('workers.', config.workers, WORKER_CONFIG_KEYS)
  requireKnownKeys('lifecycle.', config.lifecycle, LIFECYCLE_CONFIG_KEYS)
  requireKnownKeys('analysis.', config.analysis, ANALYSIS_CONFIG_KEYS)
  requireNamedPlugins(config.plugins)
}
