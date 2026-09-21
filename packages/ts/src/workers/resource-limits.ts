import { WORKER_YOUNG_GENERATION_MB } from './constants'

export interface WorkerResourceLimits {
  maxYoungGenerationSizeMb?: number
}

export function workerResourceLimits(): WorkerResourceLimits {
  return { maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_MB }
}
