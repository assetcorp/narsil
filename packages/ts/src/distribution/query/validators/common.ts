import { type ErrorCode, ErrorCodes, NarsilError } from '../../../errors'
import { MAX_PARTITION_COUNT } from '../../cluster/index-metadata'

export { MAX_PARTITION_COUNT } from '../../cluster/index-metadata'

export const MAX_PARTITION_IDS = MAX_PARTITION_COUNT

export const MAX_TERM_LENGTH = 1024
export const MAX_TERMS_COUNT = 65_536
export const MAX_FIELD_NAME_LENGTH = 255
export const MAX_FIELDS_LIST = 256
export const MAX_BOOST_FIELDS = 256
export const MAX_SORT_FIELDS = 32
export const MAX_FACETS = 64
export const MAX_FETCH_DOCUMENT_IDS = 10_000
export const MAX_DOC_ID_LENGTH = 512
export const MAX_FILTER_DEPTH = 30
export const MAX_FILTER_FIELDS = 256
export const MAX_FILTER_ARRAY_SIZE = 65_536
export const MAX_FILTER_STRING_LENGTH = 1024
export const MAX_TOLERANCE = 10
export const MAX_LIMIT = 10_000
export const MAX_OFFSET = 10_000
export const MAX_HYBRID_K = 10_000
export const MIN_HYBRID_K = 1

const NULL_BYTE = String.fromCharCode(0)

export function throwInvalid(code: ErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new NarsilError(code, message, details)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function validateStringField(
  value: unknown,
  fieldLabel: string,
  maxLength: number,
  errorCode: ErrorCode,
): string {
  if (typeof value !== 'string') {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be a string`)
  }
  if (value.length === 0) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be a non-empty string`)
  }
  if (value.length > maxLength) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" exceeds maximum length of ${maxLength}`, {
      length: value.length,
      limit: maxLength,
    })
  }
  if (value.indexOf(NULL_BYTE) !== -1) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must not contain null bytes`)
  }
  return value
}

export function validateOptionalString(
  value: unknown,
  fieldLabel: string,
  maxLength: number,
  errorCode: ErrorCode,
): string | null {
  if (value === null) {
    return null
  }
  return validateStringField(value, fieldLabel, maxLength, errorCode)
}

export function validateFieldName(value: unknown, fieldLabel: string, errorCode: ErrorCode): string {
  return validateStringField(value, fieldLabel, MAX_FIELD_NAME_LENGTH, errorCode)
}

export function validateNonNegativeInteger(
  value: unknown,
  fieldLabel: string,
  maxValue: number,
  errorCode: ErrorCode,
): number {
  if (!isInteger(value)) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be a finite non-negative integer`)
  }
  if (value < 0) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be a finite non-negative integer`)
  }
  if (value > maxValue) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" exceeds maximum value of ${maxValue}`, {
      value,
      limit: maxValue,
    })
  }
  return value
}

export function validatePositiveInteger(
  value: unknown,
  fieldLabel: string,
  maxValue: number,
  errorCode: ErrorCode,
): number {
  if (!isInteger(value)) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be a finite positive integer`)
  }
  if (value <= 0) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be a finite positive integer`)
  }
  if (value > maxValue) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" exceeds maximum value of ${maxValue}`, {
      value,
      limit: maxValue,
    })
  }
  return value
}

export function validatePartitionId(value: unknown, fieldLabel: string, errorCode: ErrorCode): number {
  if (!isInteger(value)) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be a finite integer`)
  }
  if (value < 0 || value >= MAX_PARTITION_COUNT) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be between 0 and ${MAX_PARTITION_COUNT - 1}`, {
      value,
      limit: MAX_PARTITION_COUNT,
    })
  }
  return value
}

export function validatePartitionIdsArray(value: unknown, fieldLabel: string, errorCode: ErrorCode): number[] {
  if (!Array.isArray(value)) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be an array`)
  }
  if (value.length > MAX_PARTITION_IDS) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" exceeds maximum length of ${MAX_PARTITION_IDS}`, {
      length: value.length,
      limit: MAX_PARTITION_IDS,
    })
  }
  for (let i = 0; i < value.length; i++) {
    validatePartitionId(value[i], `${fieldLabel}[${i}]`, errorCode)
  }
  return value as number[]
}

export function validateStringArray(
  value: unknown,
  fieldLabel: string,
  maxCount: number,
  maxStringLength: number,
  errorCode: ErrorCode,
): string[] {
  if (!Array.isArray(value)) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" must be an array`)
  }
  if (value.length > maxCount) {
    throwInvalid(errorCode, `Invalid payload: "${fieldLabel}" exceeds maximum length of ${maxCount}`, {
      length: value.length,
      limit: maxCount,
    })
  }
  for (let i = 0; i < value.length; i++) {
    validateStringField(value[i], `${fieldLabel}[${i}]`, maxStringLength, errorCode)
  }
  return value as string[]
}

export const SEARCH_INVALID_FIELD = ErrorCodes.SEARCH_INVALID_FIELD
export const SEARCH_INVALID_FILTER = ErrorCodes.SEARCH_INVALID_FILTER
export const SEARCH_INVALID_MODE = ErrorCodes.SEARCH_INVALID_MODE
export const CONFIG_INVALID = ErrorCodes.CONFIG_INVALID
