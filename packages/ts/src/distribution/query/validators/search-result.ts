import type { FacetBucket, SearchResultPayload } from '../../transport/types'
import {
  CONFIG_INVALID,
  isFiniteNumber,
  isInteger,
  isRecord,
  MAX_DOC_ID_LENGTH,
  throwInvalid,
  validatePartitionId,
} from './common'

const MAX_RESULTS_PER_PARTITION = 10_000

const MAX_FACET_FIELDS = 64
const MAX_FACET_BUCKETS = 10_000
const MAX_FACET_VALUE_LENGTH = 1024

function validateScoredEntry(value: unknown, fieldLabel: string): void {
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, `Invalid SearchResultPayload: "${fieldLabel}" must be an object`)
  }
  if (typeof value.docId !== 'string') {
    throwInvalid(CONFIG_INVALID, `Invalid SearchResultPayload: "${fieldLabel}.docId" must be a string`)
  }
  if (value.docId.length === 0 || value.docId.length > MAX_DOC_ID_LENGTH) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchResultPayload: "${fieldLabel}.docId" length must be between 1 and ${MAX_DOC_ID_LENGTH}`,
      { length: value.docId.length, limit: MAX_DOC_ID_LENGTH },
    )
  }
  if (!isFiniteNumber(value.score)) {
    throwInvalid(CONFIG_INVALID, `Invalid SearchResultPayload: "${fieldLabel}.score" must be a finite number`)
  }
  if (value.sortValues !== null) {
    if (!Array.isArray(value.sortValues)) {
      throwInvalid(CONFIG_INVALID, `Invalid SearchResultPayload: "${fieldLabel}.sortValues" must be an array or null`)
    }
  }
}

function validatePartitionSearchResult(value: unknown, fieldLabel: string): void {
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, `Invalid SearchResultPayload: "${fieldLabel}" must be an object`)
  }
  validatePartitionId(value.partitionId, `${fieldLabel}.partitionId`, CONFIG_INVALID)
  if (!isInteger(value.totalHits) || value.totalHits < 0) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchResultPayload: "${fieldLabel}.totalHits" must be a non-negative integer`,
    )
  }
  if (!Array.isArray(value.scored)) {
    throwInvalid(CONFIG_INVALID, `Invalid SearchResultPayload: "${fieldLabel}.scored" must be an array`)
  }
  if (value.scored.length > MAX_RESULTS_PER_PARTITION) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchResultPayload: "${fieldLabel}.scored" exceeds maximum length of ${MAX_RESULTS_PER_PARTITION}`,
      { length: value.scored.length, limit: MAX_RESULTS_PER_PARTITION },
    )
  }
  for (let i = 0; i < value.scored.length; i++) {
    validateScoredEntry(value.scored[i], `${fieldLabel}.scored[${i}]`)
  }
}

function validateFacetBucket(value: unknown, fieldLabel: string): FacetBucket {
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, `Invalid SearchResultPayload: "${fieldLabel}" must be an object`)
  }
  if (typeof value.value !== 'string') {
    throwInvalid(CONFIG_INVALID, `Invalid SearchResultPayload: "${fieldLabel}.value" must be a string`)
  }
  if (value.value.length > MAX_FACET_VALUE_LENGTH) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchResultPayload: "${fieldLabel}.value" exceeds maximum length of ${MAX_FACET_VALUE_LENGTH}`,
      { length: value.value.length, limit: MAX_FACET_VALUE_LENGTH },
    )
  }
  if (!isInteger(value.count) || value.count < 0) {
    throwInvalid(CONFIG_INVALID, `Invalid SearchResultPayload: "${fieldLabel}.count" must be a non-negative integer`)
  }
  return { value: value.value, count: value.count }
}

function validateFacets(value: unknown): void {
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchResultPayload: "facets" must be an object or null')
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_FACET_FIELDS) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchResultPayload: "facets" exceeds maximum field count of ${MAX_FACET_FIELDS}`,
      { length: entries.length, limit: MAX_FACET_FIELDS },
    )
  }
  for (const [fieldName, buckets] of entries) {
    if (typeof fieldName !== 'string' || fieldName.length === 0) {
      throwInvalid(CONFIG_INVALID, 'Invalid SearchResultPayload: each "facets" key must be a non-empty string')
    }
    if (!Array.isArray(buckets)) {
      throwInvalid(CONFIG_INVALID, `Invalid SearchResultPayload: "facets.${fieldName}" must be an array`)
    }
    if (buckets.length > MAX_FACET_BUCKETS) {
      throwInvalid(
        CONFIG_INVALID,
        `Invalid SearchResultPayload: "facets.${fieldName}" exceeds maximum bucket count of ${MAX_FACET_BUCKETS}`,
        { length: buckets.length, limit: MAX_FACET_BUCKETS },
      )
    }
    for (let i = 0; i < buckets.length; i++) {
      validateFacetBucket(buckets[i], `facets.${fieldName}[${i}]`)
    }
  }
}

export function validateSearchResultPayload(decoded: unknown): SearchResultPayload {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchResultPayload: expected an object')
  }
  if (!Array.isArray(decoded.results)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchResultPayload: "results" must be an array')
  }
  for (let i = 0; i < decoded.results.length; i++) {
    validatePartitionSearchResult(decoded.results[i], `results[${i}]`)
  }
  if (decoded.facets !== null) {
    validateFacets(decoded.facets)
  }
  return decoded as unknown as SearchResultPayload
}

export { MAX_RESULTS_PER_PARTITION }
