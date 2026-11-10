import { WORKER_YOUNG_GENERATION_MB } from '#platform/resource-limits-host'

export interface WorkerResourceLimits {
  maxYoungGenerationSizeMb?: number
  maxOldGenerationSizeMb?: number
}

export function workerResourceLimits(): WorkerResourceLimits {
  return { maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_MB }
}
