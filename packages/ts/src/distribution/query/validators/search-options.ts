import { MAX_DOC_ID_LENGTH } from '../../../engine/constants'
import {
  MAX_EF_SEARCH,
  MAX_FIELD_NAME_LENGTH,
  MAX_GROUP_FIELDS,
  MAX_HYBRID_K,
  MAX_LIMIT,
  MAX_PINNED_ENTRIES,
  MAX_PINNED_POSITION,
  MAX_PREFIX_LENGTH,
  MAX_TERMS_COUNT,
  MIN_HYBRID_K,
} from '../constants'
import {
  CONFIG_INVALID,
  isFiniteNumber,
  isInteger,
  isRecord,
  SEARCH_INVALID_FIELD,
  SEARCH_INVALID_MODE,
  throwInvalid,
  validateStringArray,
} from './common'

const ALLOWED_MODES = ['fulltext', 'vector', 'hybrid'] as const
const ALLOWED_METRICS = ['cosine', 'dotProduct', 'euclidean'] as const
const ALLOWED_HYBRID_STRATEGIES = ['rrf', 'linear'] as const

export function validateHybridParams(value: unknown): void {
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "params.hybrid" must be an object')
  }
  if (
    value.strategy !== null &&
    !ALLOWED_HYBRID_STRATEGIES.includes(value.strategy as (typeof ALLOWED_HYBRID_STRATEGIES)[number])
  ) {
    throwInvalid(
      SEARCH_INVALID_MODE,
      `Invalid SearchPayload: "params.hybrid.strategy" must be one of: ${ALLOWED_HYBRID_STRATEGIES.join(', ')}, or null`,
    )
  }
  if (value.k !== null && (!isInteger(value.k) || value.k < MIN_HYBRID_K || value.k > MAX_HYBRID_K)) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchPayload: "params.hybrid.k" must be an integer between ${MIN_HYBRID_K} and ${MAX_HYBRID_K}, or null`,
    )
  }
  if (value.alpha !== null && (!isFiniteNumber(value.alpha) || value.alpha < 0 || value.alpha > 1)) {
    throwInvalid(
      CONFIG_INVALID,
      'Invalid SearchPayload: "params.hybrid.alpha" must be a finite number in [0, 1], or null',
    )
  }
}

export function validateGroupParams(value: unknown): void {
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "params.group" must be an object')
  }
  const fields = validateStringArray(
    value.fields,
    'params.group.fields',
    MAX_GROUP_FIELDS,
    MAX_FIELD_NAME_LENGTH,
    SEARCH_INVALID_FIELD,
  )
  if (fields.length === 0) {
    throwInvalid(SEARCH_INVALID_FIELD, 'Invalid SearchPayload: "params.group.fields" must name at least one field')
  }
  if (!isInteger(value.maxPerGroup) || value.maxPerGroup <= 0 || value.maxPerGroup > MAX_LIMIT) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchPayload: "params.group.maxPerGroup" must be a positive integer at most ${MAX_LIMIT}`,
    )
  }
  if (value.limit !== null && (!isInteger(value.limit) || value.limit < 0 || value.limit > MAX_LIMIT)) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchPayload: "params.group.limit" must be a non-negative integer at most ${MAX_LIMIT}, or null`,
    )
  }
}

export function validateTermMatchParam(value: unknown): void {
  if (value === 'all' || value === 'any') {
    return
  }
  if (typeof value === 'string') {
    throwInvalid(SEARCH_INVALID_MODE, 'Invalid SearchPayload: "params.termMatch" must be "all", "any", or a count')
  }
  if (!isInteger(value) || value < 1 || value > MAX_TERMS_COUNT) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchPayload: a "params.termMatch" count must be an integer between 1 and ${MAX_TERMS_COUNT}`,
    )
  }
}

export function validatePrefixLengthParam(value: unknown): void {
  if (!isInteger(value) || value < 0 || value > MAX_PREFIX_LENGTH) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchPayload: "params.prefixLength" must be a non-negative integer at most ${MAX_PREFIX_LENGTH}`,
    )
  }
}

export function validateBooleanParam(value: unknown, fieldLabel: string): void {
  if (typeof value !== 'boolean') {
    throwInvalid(CONFIG_INVALID, `Invalid SearchPayload: "params.${fieldLabel}" must be a boolean or null`)
  }
}

export function validatePinnedParam(value: unknown): void {
  if (!Array.isArray(value)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchPayload: "params.pinned" must be an array or null')
  }
  if (value.length > MAX_PINNED_ENTRIES) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchPayload: "params.pinned" exceeds maximum length of ${MAX_PINNED_ENTRIES}`,
      { length: value.length, limit: MAX_PINNED_ENTRIES },
    )
  }
  for (let i = 0; i < value.length; i++) {
    const entry = value[i]
    if (!isRecord(entry)) {
      throwInvalid(CONFIG_INVALID, `Invalid SearchPayload: "params.pinned[${i}]" must be an object`)
    }
    if (typeof entry.docId !== 'string' || entry.docId.length === 0 || entry.docId.length > MAX_DOC_ID_LENGTH) {
      throwInvalid(
        CONFIG_INVALID,
        `Invalid SearchPayload: "params.pinned[${i}].docId" must be a string of 1 to ${MAX_DOC_ID_LENGTH} characters`,
      )
    }
    if (!isInteger(entry.position) || entry.position < 0 || entry.position > MAX_PINNED_POSITION) {
      throwInvalid(
        CONFIG_INVALID,
        `Invalid SearchPayload: "params.pinned[${i}].position" must be an integer between 0 and ${MAX_PINNED_POSITION}`,
      )
    }
  }
}

export function validateModeParam(value: unknown): void {
  if (!ALLOWED_MODES.includes(value as (typeof ALLOWED_MODES)[number])) {
    throwInvalid(
      SEARCH_INVALID_MODE,
      `Invalid SearchPayload: "params.mode" must be one of: ${ALLOWED_MODES.join(', ')}`,
    )
  }
}

export function validateVectorMetricParam(value: unknown): void {
  if (!ALLOWED_METRICS.includes(value as (typeof ALLOWED_METRICS)[number])) {
    throwInvalid(
      SEARCH_INVALID_MODE,
      `Invalid SearchPayload: "params.vector.metric" must be one of: ${ALLOWED_METRICS.join(', ')}`,
    )
  }
}

export function validateEfSearchParam(value: unknown): void {
  if (!isInteger(value) || value < 1 || value > MAX_EF_SEARCH) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchPayload: "params.vector.efSearch" must be an integer between 1 and ${MAX_EF_SEARCH}`,
    )
  }
}
