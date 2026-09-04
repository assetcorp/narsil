export const WORKER_YOUNG_GENERATION_MB = 24

export interface WorkerResourceLimits {
  maxYoungGenerationSizeMb?: number
}

export const WORKER_RESOURCE_LIMITS: WorkerResourceLimits = { maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_MB }
