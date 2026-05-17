import { validateIndexName } from '../../cluster/index-metadata'
import type { SearchPayload } from '../../transport/types'
import { MAX_CURSOR_LENGTH } from '../cursor'
import {
  CONFIG_INVALID,
  isFiniteNumber,
  isInteger,
  isRecord,
  MAX_BOOST_FIELDS,
  MAX_FACETS,
  MAX_FIELDS_LIST,
  MAX_HYBRID_K,
  MAX_LIMIT,
  MAX_OFFSET,
  MAX_SORT_FIELDS,
  MAX_TERM_LENGTH,
  MAX_TOLERANCE,
  MIN_HYBRID_K,
  SEARCH_INVALID_FIELD,
  SEARCH_INVALID_MODE,
  throwInvalid,
  validateFieldName,
  validateNonNegativeInteger,
  validatePartitionIdsArray,
  validateStringArray,
  validateStringField,
} from './common'
import { validateFilterExpression } from './filters'

export const MAX_FACET_SHARD_SIZE = Math.ceil(1_000 * 1.5) + 10

export const MAX_VECTOR_DIMENSION = 8192

export const MAX_VECTOR_TEXT_LENGTH = 16_384

const ALLOWED_SCORING = ['local', 'dfs', 'broadcast'] as const
const ALLOWED_SORT_DIRECTIONS = ['asc', 'desc'] as const
const ALLOWED_HYBRID_STRATEGIES = ['rrf', 'linear'] as const

function validateIndexNameField(value: unknown, fieldLabel: string): string {
  if (typeof value !== 'string') {
    throwInvalid(CONFIG_INVALID, `Invalid SearchPayload: "${fieldLabel}" must be a string`)
  }
  validateIndexName(value)
  return value
}

function validateVectorParams(value: unknown): void {
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "params.vector" must be an object')
  }
  validateFieldName(value.field, 'params.vector.field', SEARCH_INVALID_FIELD)
  if (value.value !== null) {
    if (!Array.isArray(value.value)) {
      throwInvalid(
        CONFIG_INVALID,
        'Invalid SearchPayload: "params.vector.value" must be an array of finite numbers or null',
      )
    }
    const dims = value.value.length
    if (dims === 0 || dims > MAX_VECTOR_DIMENSION) {
      throwInvalid(
        CONFIG_INVALID,
        `Invalid SearchPayload: "params.vector.value" length must be between 1 and ${MAX_VECTOR_DIMENSION}`,
        { length: dims, limit: MAX_VECTOR_DIMENSION },
      )
    }
    for (let i = 0; i < dims; i++) {
      const component = value.value[i]
      if (typeof component !== 'number' || !Number.isFinite(component)) {
        throwInvalid(CONFIG_INVALID, `Invalid SearchPayload: "params.vector.value[${i}]" must be a finite number`)
      }
    }
  }
  if (value.text !== null) {
    if (typeof value.text !== 'string') {
      throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "params.vector.text" must be a string or null')
    }
    if (value.text.length > MAX_VECTOR_TEXT_LENGTH) {
      throwInvalid(
        CONFIG_INVALID,
        `Invalid SearchPayload: "params.vector.text" length must be at most ${MAX_VECTOR_TEXT_LENGTH} characters`,
        { length: value.text.length, limit: MAX_VECTOR_TEXT_LENGTH },
      )
    }
  }
  if (value.similarity !== null) {
    if (typeof value.similarity !== 'number' || !Number.isFinite(value.similarity)) {
      throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "params.vector.similarity" must be a finite number or null')
    }
  }
}

function validateHybridParams(value: unknown): void {
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "params.hybrid" must be an object')
  }
  if (!ALLOWED_HYBRID_STRATEGIES.includes(value.strategy as (typeof ALLOWED_HYBRID_STRATEGIES)[number])) {
    throwInvalid(
      SEARCH_INVALID_MODE,
      `Invalid SearchPayload: "params.hybrid.strategy" must be one of: ${ALLOWED_HYBRID_STRATEGIES.join(', ')}`,
    )
  }
  if (!isInteger(value.k) || value.k < MIN_HYBRID_K || value.k > MAX_HYBRID_K) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchPayload: "params.hybrid.k" must be an integer between ${MIN_HYBRID_K} and ${MAX_HYBRID_K}`,
    )
  }
  if (!isFiniteNumber(value.alpha) || value.alpha < 0 || value.alpha > 1) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "params.hybrid.alpha" must be a finite number in [0, 1]')
  }
}

function validateGroupParams(value: unknown): void {
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "params.group" must be an object')
  }
  validateFieldName(value.field, 'params.group.field', SEARCH_INVALID_FIELD)
  if (!isInteger(value.maxPerGroup) || value.maxPerGroup <= 0 || value.maxPerGroup > MAX_LIMIT) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchPayload: "params.group.maxPerGroup" must be a positive integer at most ${MAX_LIMIT}`,
    )
  }
}

function validateSortParams(value: unknown): void {
  if (!Array.isArray(value)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "params.sort" must be an array or null')
  }
  if (value.length > MAX_SORT_FIELDS) {
    throwInvalid(CONFIG_INVALID, `Invalid SearchPayload: "params.sort" exceeds maximum length of ${MAX_SORT_FIELDS}`, {
      length: value.length,
      limit: MAX_SORT_FIELDS,
    })
  }
  for (let i = 0; i < value.length; i++) {
    const entry = value[i]
    if (!isRecord(entry)) {
      throwInvalid(CONFIG_INVALID, `Invalid SearchPayload: "params.sort[${i}]" must be an object`)
    }
    validateFieldName(entry.field, `params.sort[${i}].field`, SEARCH_INVALID_FIELD)
    if (!ALLOWED_SORT_DIRECTIONS.includes(entry.direction as (typeof ALLOWED_SORT_DIRECTIONS)[number])) {
      throwInvalid(
        SEARCH_INVALID_MODE,
        `Invalid SearchPayload: "params.sort[${i}].direction" must be one of: ${ALLOWED_SORT_DIRECTIONS.join(', ')}`,
      )
    }
  }
}

function validateBoostParams(value: unknown): void {
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "params.boost" must be an object or null')
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_BOOST_FIELDS) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchPayload: "params.boost" exceeds maximum field count of ${MAX_BOOST_FIELDS}`,
      { length: entries.length, limit: MAX_BOOST_FIELDS },
    )
  }
  for (const [fieldName, boostValue] of entries) {
    validateFieldName(fieldName, 'params.boost<key>', SEARCH_INVALID_FIELD)
    if (!isFiniteNumber(boostValue)) {
      throwInvalid(CONFIG_INVALID, `Invalid SearchPayload: "params.boost.${fieldName}" must be a finite number`)
    }
  }
}

function validateGlobalStatsShape(value: unknown): void {
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "globalStats" must be an object or null')
  }
  if (!isFiniteNumber(value.totalDocuments) || value.totalDocuments < 0) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "globalStats.totalDocuments" must be a non-negative number')
  }
  if (!isRecord(value.docFrequencies)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "globalStats.docFrequencies" must be an object')
  }
  if (!isRecord(value.totalFieldLengths)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "globalStats.totalFieldLengths" must be an object')
  }
}

function validateParams(params: Record<string, unknown>): void {
  if (params.term !== null) {
    validateStringField(params.term, 'params.term', MAX_TERM_LENGTH, CONFIG_INVALID)
  }

  if (params.filters !== null) {
    validateFilterExpression(params.filters, 'params.filters')
  }

  if (params.sort !== null) {
    validateSortParams(params.sort)
  }

  if (params.group !== null) {
    validateGroupParams(params.group)
  }

  if (params.facets !== null) {
    validateStringArray(params.facets, 'params.facets', MAX_FACETS, 255, SEARCH_INVALID_FIELD)
  }

  if (params.facetSize !== null) {
    validateNonNegativeInteger(params.facetSize, 'params.facetSize', MAX_LIMIT, CONFIG_INVALID)
  }

  if (!isInteger(params.limit) || params.limit < 0 || params.limit > MAX_LIMIT) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchPayload: "params.limit" must be a non-negative integer at most ${MAX_LIMIT}`,
    )
  }

  if (!isInteger(params.offset) || params.offset < 0 || params.offset > MAX_OFFSET) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchPayload: "params.offset" must be a non-negative integer at most ${MAX_OFFSET}`,
    )
  }

  if (params.searchAfter !== null) {
    if (typeof params.searchAfter !== 'string') {
      throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "params.searchAfter" must be a string or null')
    }
    if (params.searchAfter.length > MAX_CURSOR_LENGTH) {
      throwInvalid(
        CONFIG_INVALID,
        `Invalid SearchPayload: "params.searchAfter" exceeds maximum length of ${MAX_CURSOR_LENGTH}`,
        { length: params.searchAfter.length, limit: MAX_CURSOR_LENGTH },
      )
    }
  }

  if (params.fields !== null) {
    validateStringArray(params.fields, 'params.fields', MAX_FIELDS_LIST, 255, SEARCH_INVALID_FIELD)
  }

  if (params.boost !== null) {
    validateBoostParams(params.boost)
  }

  if (params.tolerance !== null) {
    if (!isInteger(params.tolerance) || params.tolerance < 0 || params.tolerance > MAX_TOLERANCE) {
      throwInvalid(
        CONFIG_INVALID,
        `Invalid SearchPayload: "params.tolerance" must be a non-negative integer at most ${MAX_TOLERANCE}`,
      )
    }
  }

  if (params.threshold !== null) {
    if (!isFiniteNumber(params.threshold)) {
      throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "params.threshold" must be a finite number or null')
    }
  }

  if (!ALLOWED_SCORING.includes(params.scoring as (typeof ALLOWED_SCORING)[number])) {
    throwInvalid(
      SEARCH_INVALID_MODE,
      `Invalid SearchPayload: "params.scoring" must be one of: ${ALLOWED_SCORING.join(', ')}`,
    )
  }

  if (params.vector !== null) {
    validateVectorParams(params.vector)
  }

  if (params.hybrid !== null) {
    validateHybridParams(params.hybrid)
  }
}

export function validateSearchPayload(decoded: unknown): SearchPayload {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: expected an object')
  }

  validateIndexNameField(decoded.indexName, 'indexName')
  validatePartitionIdsArray(decoded.partitionIds, 'partitionIds', CONFIG_INVALID)

  if (!isRecord(decoded.params)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "params" must be an object')
  }
  validateParams(decoded.params)

  if (decoded.globalStats !== null) {
    validateGlobalStatsShape(decoded.globalStats)
  }

  if (decoded.facetShardSize !== null) {
    if (!isFiniteNumber(decoded.facetShardSize)) {
      throwInvalid(
        CONFIG_INVALID,
        `Invalid SearchPayload: "facetShardSize" must be between 1 and ${MAX_FACET_SHARD_SIZE}, or null`,
      )
    }
    const shardSize = decoded.facetShardSize as number
    if (shardSize < 1 || shardSize > MAX_FACET_SHARD_SIZE) {
      throwInvalid(
        CONFIG_INVALID,
        `Invalid SearchPayload: "facetShardSize" must be between 1 and ${MAX_FACET_SHARD_SIZE}, or null`,
        { value: shardSize, limit: MAX_FACET_SHARD_SIZE },
      )
    }
  }

  return decoded as unknown as SearchPayload
}
