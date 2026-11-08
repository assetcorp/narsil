import { WORKER_YOUNG_GENERATION_MB } from '#platform/vector-host'

export interface WorkerResourceLimits {
  maxYoungGenerationSizeMb?: number
  maxOldGenerationSizeMb?: number
}

export function workerResourceLimits(): WorkerResourceLimits {
  return { maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_MB }
}
