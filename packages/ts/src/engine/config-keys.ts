import { ErrorCodes, NarsilError } from '../errors'
import type {
  AnalysisConfig,
  DurabilityConfig,
  IndexLifecycleConfig,
  NarsilConfig,
  WorkerConfig,
} from '../types/config'
import type { NarsilEventMap } from '../types/events'

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
  patternWorkCap: true,
  events: true,
}

const EVENT_NAMES: Record<keyof NarsilEventMap, true> = {
  write: true,
  workerCrash: true,
  workerPromote: true,
  workerPromoteFailure: true,
  partitionRebalance: true,
  partitionWatermark: true,
  heapPressure: true,
  analysisRebuild: true,
  layoutUpgrade: true,
  durabilityError: true,
  invalidationError: true,
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
  requireValidPatternWorkCap(config.patternWorkCap)
  requireEventListeners(config.events)
}

function requireEventListeners(events: unknown): void {
  if (events === undefined) return
  if (typeof events !== 'object' || events === null || Array.isArray(events)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'The configuration sets "events" to something other than an object that maps event names to functions',
      { setting: 'events' },
    )
  }
  requireKnownKeys('events.', events, EVENT_NAMES)
  for (const [event, listener] of Object.entries(events)) {
    if (listener === undefined || typeof listener === 'function') continue
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `The configuration sets "events.${event}" to something other than a function`,
      { setting: `events.${event}` },
    )
  }
}

function requireValidPatternWorkCap(cap: unknown): void {
  if (cap === undefined) return
  if (typeof cap === 'number' && Number.isSafeInteger(cap) && cap >= 1) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `The configuration sets "patternWorkCap" to ${String(cap)}, while the cap must be a whole number from 1 to ${Number.MAX_SAFE_INTEGER}`,
    { setting: 'patternWorkCap' },
  )
}
