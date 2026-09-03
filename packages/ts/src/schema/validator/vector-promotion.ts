import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorIndexConfig } from '../../types/schema'
import { MAX_M } from '../../vector/hnsw/adjacency'

function fail(message: string, details: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, message, details)
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 1
}

export function validateVectorPromotion(config: VectorIndexConfig | undefined): void {
  if (config === undefined) return

  if (config.threshold !== undefined && !isPositiveInteger(config.threshold)) {
    fail('vectorPromotion.threshold must be a positive integer', { threshold: config.threshold })
  }

  const quantization: unknown = config.quantization
  if (quantization !== undefined && quantization !== 'sq8' && quantization !== 'none') {
    fail("vectorPromotion.quantization must be 'sq8' or 'none'", { quantization })
  }

  const hnsw = config.hnswConfig
  if (hnsw === undefined) return

  if (hnsw.m !== undefined && (!isPositiveInteger(hnsw.m) || hnsw.m > MAX_M)) {
    fail(`vectorPromotion.hnswConfig.m must be a positive integer no greater than ${MAX_M}`, { m: hnsw.m })
  }

  if (hnsw.efConstruction !== undefined && !isPositiveInteger(hnsw.efConstruction)) {
    fail('vectorPromotion.hnswConfig.efConstruction must be a positive integer', {
      efConstruction: hnsw.efConstruction,
    })
  }

  const metric: unknown = hnsw.metric
  if (metric !== undefined && metric !== 'cosine' && metric !== 'dotProduct' && metric !== 'euclidean') {
    fail("vectorPromotion.hnswConfig.metric must be 'cosine', 'dotProduct', or 'euclidean'", { metric })
  }
}
