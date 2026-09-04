import { WORKER_YOUNG_GENERATION_MB } from './constants'

export interface WorkerResourceLimits {
  maxYoungGenerationSizeMb?: number
}

export const WORKER_RESOURCE_LIMITS: WorkerResourceLimits = { maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_MB }
