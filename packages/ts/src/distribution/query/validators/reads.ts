import { MAX_DOC_ID_LENGTH } from '../../../engine/constants'
import { MAX_SORT_FIELDS } from '../../../search/constants'
import type {
  CountPayload,
  CountResultPayload,
  ListPayload,
  ListResultPayload,
  PreflightPayload,
  PreflightResultPayload,
  SuggestPayload,
  SuggestResultPayload,
} from '../../transport/types'
import {
  MAX_COUNT_VALUE,
  MAX_FIELDS_LIST,
  MAX_LANGUAGE_NAME_LENGTH,
  MAX_LIMIT,
  MAX_LIST_CURSOR_LENGTH,
  MAX_SORT_VALUE_STRING_LENGTH,
  MAX_SUGGEST_WIRE_LIMIT,
  MAX_TERM_LENGTH,
} from '../constants'
import {
  CONFIG_INVALID,
  isInteger,
  isRecord,
  SEARCH_INVALID_FIELD,
  SEARCH_INVALID_MODE,
  throwInvalid,
  validateFieldName,
  validateNonNegativeInteger,
  validatePartitionIdsArray,
  validatePositiveInteger,
  validateStringArray,
  validateStringField,
} from './common'
import { validateFilterExpression } from './filters'
import { validateWireParams } from './search'

function validateIndexNameField(decoded: Record<string, unknown>, payloadLabel: string): void {
  validateStringField(decoded.indexName, `${payloadLabel}.indexName`, 255, CONFIG_INVALID)
}

export function validateCountPayload(decoded: unknown): CountPayload {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid CountPayload: expected an object')
  }
  validateIndexNameField(decoded, 'CountPayload')
  validatePartitionIdsArray(decoded.partitionIds, 'partitionIds', CONFIG_INVALID)
  return decoded as unknown as CountPayload
}

export function validateCountResultPayload(decoded: unknown): CountResultPayload {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid CountResultPayload: expected an object')
  }
  if (!Array.isArray(decoded.partitions)) {
    throwInvalid(CONFIG_INVALID, 'Invalid CountResultPayload: "partitions" must be an array')
  }
  for (let i = 0; i < decoded.partitions.length; i++) {
    const entry = decoded.partitions[i]
    if (!isRecord(entry)) {
      throwInvalid(CONFIG_INVALID, `Invalid CountResultPayload: "partitions[${i}]" must be an object`)
    }
    validateNonNegativeInteger(entry.partitionId, `partitions[${i}].partitionId`, MAX_COUNT_VALUE, CONFIG_INVALID)
    validateNonNegativeInteger(entry.documentCount, `partitions[${i}].documentCount`, MAX_COUNT_VALUE, CONFIG_INVALID)
    validateNonNegativeInteger(
      entry.estimatedMemoryBytes,
      `partitions[${i}].estimatedMemoryBytes`,
      MAX_COUNT_VALUE,
      CONFIG_INVALID,
    )
  }
  validateStringField(decoded.language, 'language', MAX_LANGUAGE_NAME_LENGTH, CONFIG_INVALID)
  return decoded as unknown as CountResultPayload
}

function validateListSort(value: unknown): void {
  if (!Array.isArray(value)) {
    throwInvalid(CONFIG_INVALID, 'Invalid ListPayload: "sort" must be an array or null')
  }
  if (value.length > MAX_SORT_FIELDS) {
    throwInvalid(SEARCH_INVALID_FIELD, `Invalid ListPayload: "sort" exceeds maximum length of ${MAX_SORT_FIELDS}`, {
      length: value.length,
      limit: MAX_SORT_FIELDS,
    })
  }
  for (let i = 0; i < value.length; i++) {
    const entry = value[i]
    if (!isRecord(entry)) {
      throwInvalid(CONFIG_INVALID, `Invalid ListPayload: "sort[${i}]" must be an object`)
    }
    validateFieldName(entry.field, `sort[${i}].field`, SEARCH_INVALID_FIELD)
    if (entry.direction !== 'asc' && entry.direction !== 'desc') {
      throwInvalid(SEARCH_INVALID_MODE, `Invalid ListPayload: "sort[${i}].direction" must be "asc" or "desc"`)
    }
  }
}

export function validateListPayload(decoded: unknown): ListPayload {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid ListPayload: expected an object')
  }
  validateIndexNameField(decoded, 'ListPayload')
  validatePartitionIdsArray(decoded.partitionIds, 'partitionIds', CONFIG_INVALID)
  if (decoded.cursor !== null) {
    validateStringField(decoded.cursor, 'cursor', MAX_LIST_CURSOR_LENGTH, CONFIG_INVALID)
  }
  validatePositiveInteger(decoded.limit, 'limit', MAX_LIMIT, CONFIG_INVALID)
  if (decoded.filters !== null) {
    validateFilterExpression(decoded.filters, 'filters')
  }
  if (decoded.sort !== null) {
    validateListSort(decoded.sort)
  }
  if (decoded.fields !== null) {
    validateStringArray(decoded.fields, 'fields', MAX_FIELDS_LIST, 255, SEARCH_INVALID_FIELD)
  }
  return decoded as unknown as ListPayload
}

function validateSortValues(value: unknown, fieldLabel: string): void {
  if (!Array.isArray(value)) {
    throwInvalid(CONFIG_INVALID, `Invalid ListResultPayload: "${fieldLabel}" must be an array or null`)
  }
  if (value.length > MAX_SORT_FIELDS) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid ListResultPayload: "${fieldLabel}" exceeds maximum length of ${MAX_SORT_FIELDS}`,
    )
  }
  for (let i = 0; i < value.length; i++) {
    const sortValue = value[i]
    if (sortValue === null || typeof sortValue === 'number' || typeof sortValue === 'boolean') {
      continue
    }
    if (typeof sortValue === 'string') {
      if (sortValue.length > MAX_SORT_VALUE_STRING_LENGTH) {
        throwInvalid(CONFIG_INVALID, `Invalid ListResultPayload: "${fieldLabel}[${i}]" exceeds maximum string length`)
      }
      continue
    }
    throwInvalid(CONFIG_INVALID, `Invalid ListResultPayload: "${fieldLabel}[${i}]" must be a scalar or null`)
  }
}

export function validateListResultPayload(decoded: unknown): ListResultPayload {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid ListResultPayload: expected an object')
  }
  if (!Array.isArray(decoded.entries)) {
    throwInvalid(CONFIG_INVALID, 'Invalid ListResultPayload: "entries" must be an array')
  }
  if (decoded.entries.length > MAX_LIMIT) {
    throwInvalid(CONFIG_INVALID, `Invalid ListResultPayload: "entries" exceeds maximum length of ${MAX_LIMIT}`)
  }
  for (let i = 0; i < decoded.entries.length; i++) {
    const entry = decoded.entries[i]
    if (!isRecord(entry)) {
      throwInvalid(CONFIG_INVALID, `Invalid ListResultPayload: "entries[${i}]" must be an object`)
    }
    validateStringField(entry.docId, `entries[${i}].docId`, MAX_DOC_ID_LENGTH, CONFIG_INVALID)
    if (!isRecord(entry.document)) {
      throwInvalid(CONFIG_INVALID, `Invalid ListResultPayload: "entries[${i}].document" must be an object`)
    }
    if (entry.sortValues !== null) {
      validateSortValues(entry.sortValues, `entries[${i}].sortValues`)
    }
  }
  validateNonNegativeInteger(decoded.total, 'total', MAX_COUNT_VALUE, CONFIG_INVALID)
  if (typeof decoded.hasMore !== 'boolean') {
    throwInvalid(CONFIG_INVALID, 'Invalid ListResultPayload: "hasMore" must be a boolean')
  }
  return decoded as unknown as ListResultPayload
}

export function validateSuggestPayload(decoded: unknown): SuggestPayload {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SuggestPayload: expected an object')
  }
  validateIndexNameField(decoded, 'SuggestPayload')
  validatePartitionIdsArray(decoded.partitionIds, 'partitionIds', CONFIG_INVALID)
  validateStringField(decoded.prefix, 'prefix', MAX_TERM_LENGTH, CONFIG_INVALID)
  validatePositiveInteger(decoded.limit, 'limit', MAX_SUGGEST_WIRE_LIMIT, CONFIG_INVALID)
  return decoded as unknown as SuggestPayload
}

export function validateSuggestResultPayload(decoded: unknown): SuggestResultPayload {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SuggestResultPayload: expected an object')
  }
  if (!Array.isArray(decoded.terms)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SuggestResultPayload: "terms" must be an array')
  }
  if (decoded.terms.length > MAX_SUGGEST_WIRE_LIMIT) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SuggestResultPayload: "terms" exceeds maximum length of ${MAX_SUGGEST_WIRE_LIMIT}`,
    )
  }
  for (let i = 0; i < decoded.terms.length; i++) {
    const entry = decoded.terms[i]
    if (!isRecord(entry)) {
      throwInvalid(CONFIG_INVALID, `Invalid SuggestResultPayload: "terms[${i}]" must be an object`)
    }
    validateStringField(entry.term, `terms[${i}].term`, MAX_TERM_LENGTH, CONFIG_INVALID)
    validateNonNegativeInteger(
      entry.documentFrequency,
      `terms[${i}].documentFrequency`,
      MAX_COUNT_VALUE,
      CONFIG_INVALID,
    )
  }
  if (typeof decoded.analysisStale !== 'boolean') {
    throwInvalid(CONFIG_INVALID, 'Invalid SuggestResultPayload: "analysisStale" must be a boolean')
  }
  return decoded as unknown as SuggestResultPayload
}

export function validatePreflightPayload(decoded: unknown): PreflightPayload {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid PreflightPayload: expected an object')
  }
  validateIndexNameField(decoded, 'PreflightPayload')
  validatePartitionIdsArray(decoded.partitionIds, 'partitionIds', CONFIG_INVALID)
  validateWireParams(decoded.params)
  return decoded as unknown as PreflightPayload
}

export function validatePreflightResultPayload(decoded: unknown): PreflightResultPayload {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid PreflightResultPayload: expected an object')
  }
  if (!isInteger(decoded.count) || decoded.count < 0) {
    throwInvalid(CONFIG_INVALID, 'Invalid PreflightResultPayload: "count" must be a non-negative integer')
  }
  if (typeof decoded.analysisStale !== 'boolean') {
    throwInvalid(CONFIG_INVALID, 'Invalid PreflightResultPayload: "analysisStale" must be a boolean')
  }
  return decoded as unknown as PreflightResultPayload
}
