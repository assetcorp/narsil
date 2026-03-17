import { ErrorCodes, NarsilError } from '../errors'

const INDEX_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const MAX_INDEX_NAME_LENGTH = 256
const MAX_DOC_ID_LENGTH = 512

export const BATCH_CHUNK_SIZE = 1000
export const MAX_LIMIT = 10_000
export const MAX_OFFSET = 100_000
export const DEFAULT_LIMIT = 10
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

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT
  return Math.max(0, Math.min(limit, MAX_LIMIT))
}

export function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return DEFAULT_OFFSET
  return Math.max(0, Math.min(offset, MAX_OFFSET))
}
