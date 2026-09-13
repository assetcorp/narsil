import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorIndexConfig } from '../../types/schema'
import { MAX_M } from '../../vector/hnsw/constants'

const QUANTIZATION_MODES: ReadonlySet<string> = new Set(['osq8', 'osq4', 'osq2', 'osq1', 'none'])
const STORAGE_MODES: ReadonlySet<string> = new Set(['memory', 'disk'])

function fail(message: string, details: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, message, details)
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 1
}

/**
 * Reports whether a value names a quantisation mode this engine accepts.
 *
 * @internal
 */
export function isQuantizationMode(value: unknown): value is NonNullable<VectorIndexConfig['quantization']> {
  return typeof value === 'string' && QUANTIZATION_MODES.has(value)
}

/**
 * Reports whether a value names a storage mode this engine accepts.
 *
 * @internal
 */
export function isStorageMode(value: unknown): value is NonNullable<VectorIndexConfig['storage']> {
  return typeof value === 'string' && STORAGE_MODES.has(value)
}

/**
 * Refuses a field kept on disk on an engine without filesystem durability,
 * because only a durable checkpoint writes the file the field reads.
 *
 * @param config The vector promotion settings, or undefined where the index names none.
 * @param filesystemDurability Whether the engine writes checkpoints to a filesystem directory.
 *
 * @internal
 */
export function validateVectorStorage(config: VectorIndexConfig | undefined, filesystemDurability: boolean): void {
  if (config?.storage === 'disk' && !filesystemDurability) {
    fail("vectorPromotion.storage 'disk' needs filesystem durability, because a checkpoint file holds the vectors", {
      storage: config.storage,
    })
  }
}

export function validateVectorPromotion(config: VectorIndexConfig | undefined): void {
  if (config === undefined) return

  if (config.threshold !== undefined && !isPositiveInteger(config.threshold)) {
    fail('vectorPromotion.threshold must be a positive integer', { threshold: config.threshold })
  }

  const quantization: unknown = config.quantization
  if (quantization !== undefined && !isQuantizationMode(quantization)) {
    fail("vectorPromotion.quantization must be 'osq8', 'osq4', 'osq2', 'osq1', or 'none'", { quantization })
  }

  const storage: unknown = config.storage
  if (storage !== undefined && !isStorageMode(storage)) {
    fail("vectorPromotion.storage must be 'memory' or 'disk'", { storage })
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
