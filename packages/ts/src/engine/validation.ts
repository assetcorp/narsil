import { MAX_INDEX_NAME_LENGTH } from '../distribution/cluster/index-metadata'
import { ErrorCodes, NarsilError } from '../errors'
import { clampRowCount, DEFAULT_PAGE_SIZE } from '../search/pagination'
import type { WorkerConfig } from '../types/config'
import type { BM25Params } from '../types/schema'

const INDEX_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const MAX_DOC_ID_LENGTH = 512

export const BATCH_CHUNK_SIZE = 1000
export const DEFAULT_LIMIT = DEFAULT_PAGE_SIZE
export const DEFAULT_OFFSET = 0

export function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

export function validateIndexName(name: string): void {
  if (!name || name.length === 0) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, 'Index name must not be empty', { indexName: name })
  }

  if (name.length > MAX_INDEX_NAME_LENGTH) {
    throw new NarsilError(
      ErrorCodes.INDEX_NOT_FOUND,
      `Index name must not exceed ${MAX_INDEX_NAME_LENGTH} characters`,
      {
        indexName: name,
        length: name.length,
      },
    )
  }

  if (!INDEX_NAME_PATTERN.test(name)) {
    throw new NarsilError(
      ErrorCodes.INDEX_NOT_FOUND,
      `Index name "${name}" contains invalid characters; use alphanumeric, dots, hyphens, and underscores only`,
      { indexName: name },
    )
  }

  if (name.includes('..')) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index name "${name}" must not contain ".."`, { indexName: name })
  }
}

export function validateDocId(docId: string): void {
  if (!docId || docId.length === 0) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Document ID must not be empty', { docId })
  }

  if (docId.length > MAX_DOC_ID_LENGTH) {
    throw new NarsilError(
      ErrorCodes.DOC_VALIDATION_FAILED,
      `Document ID must not exceed ${MAX_DOC_ID_LENGTH} characters`,
      {
        docId,
        length: docId.length,
      },
    )
  }

  if (docId.includes('\0')) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Document ID must not contain null bytes', { docId })
  }
}

export function validatePartitionConfig(partitions: {
  maxDocsPerPartition?: number
  maxPartitions?: number
  watermark?: number
}): void {
  const { maxDocsPerPartition, maxPartitions, watermark } = partitions
  if (maxDocsPerPartition !== undefined && (!Number.isInteger(maxDocsPerPartition) || maxDocsPerPartition < 1)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'partitions.maxDocsPerPartition must be a positive integer', {
      maxDocsPerPartition,
    })
  }
  if (maxPartitions !== undefined && (!Number.isInteger(maxPartitions) || maxPartitions < 1)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'partitions.maxPartitions must be a positive integer', {
      maxPartitions,
    })
  }
  if (watermark !== undefined && (typeof watermark !== 'number' || !(watermark > 0) || watermark > 1)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'partitions.watermark must be above 0 and at most 1', {
      watermark,
    })
  }
}

function requirePositiveSafeInteger(field: string, value: number | undefined): void {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `${field} must be a positive safe integer`, { field, value })
  }
}

export function validateWorkerConfig(workers: WorkerConfig | undefined): void {
  if (workers === undefined) return
  requirePositiveSafeInteger('workers.count', workers.count)
  requirePositiveSafeInteger('workers.promotionThreshold', workers.promotionThreshold)
  requirePositiveSafeInteger('workers.idleTimeoutMs', workers.idleTimeoutMs)
}

export function validateBM25Params(bm25: BM25Params | undefined): void {
  if (bm25 === undefined) return
  const { k1, b } = bm25
  if (k1 !== undefined && (!Number.isFinite(k1) || k1 < 0)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'bm25.k1 must be a finite number at or above 0', { k1 })
  }
  if (b !== undefined && (!Number.isFinite(b) || b < 0 || b > 1)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'bm25.b must be between 0 and 1', { b })
  }
}

export function clampLimit(limit: number | undefined): number {
  return clampRowCount(limit, DEFAULT_LIMIT)
}

export function clampOffset(offset: number | undefined): number {
  return clampRowCount(offset, DEFAULT_OFFSET)
}
