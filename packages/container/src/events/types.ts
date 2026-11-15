import type { NarsilEventMap } from '@delali/narsil'

export type EngineEventName = Exclude<keyof NarsilEventMap, 'write'>

const ENGINE_EVENT_SET: Readonly<Record<EngineEventName, true>> = {
  workerCrash: true,
  workerPromote: true,
  workerPromoteFailure: true,
  partitionRebalance: true,
  partitionWatermark: true,
  heapPressure: true,
  analysisRebuild: true,
  layoutUpgrade: true,
  checkpointHeld: true,
  durabilityError: true,
  invalidationError: true,
  querySuggestionsBuild: true,
  querySuggestionsWarning: true,
}

export const ENGINE_EVENT_NAMES = Object.keys(ENGINE_EVENT_SET) as EngineEventName[]

export const TASK_FINISHED_TYPE = 'task.finished'
export const ENGINE_TYPE_PREFIX = 'engine.'

export const EVENT_TYPES: ReadonlySet<string> = new Set([
  ...ENGINE_EVENT_NAMES.map(name => `${ENGINE_TYPE_PREFIX}${name}`),
  TASK_FINISHED_TYPE,
])

export const WEBHOOK_DROPPED_TYPE = 'webhook.dropped'
export const WEBHOOK_STOPPED_TYPE = 'webhook.stopped'
