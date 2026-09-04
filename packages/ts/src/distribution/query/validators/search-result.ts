import { MAX_DOC_ID_LENGTH } from '../../../engine/constants'
import type { FacetBucket, SearchResultPayload } from '../../transport/types'
import {
  MAX_FACET_BUCKETS,
  MAX_FACET_FIELDS,
  MAX_FACET_VALUE_LENGTH,
  MAX_GROUPS_PER_RESPONSE,
  MAX_RESULTS_PER_PARTITION,
  MAX_SORT_VALUES,
} from '../constants'
import { CONFIG_INVALID, isFiniteNumber, isInteger, isRecord, throwInvalid, validatePartitionId } from './common'

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
  const scoreAbsent = value.score === null || value.score === undefined
  if (scoreAbsent) {
    if (!Array.isArray(value.sortValues)) {
      throwInvalid(
        CONFIG_INVALID,
        `Invalid SearchResultPayload: "${fieldLabel}.score" is absent only where "sortValues" carries the sort key`,
      )
    }
  } else if (!isFiniteNumber(value.score)) {
    throwInvalid(CONFIG_INVALID, `Invalid SearchResultPayload: "${fieldLabel}.score" must be a finite number`)
  }
  if (value.sortValues !== null && value.sortValues !== undefined) {
    if (!Array.isArray(value.sortValues)) {
      throwInvalid(CONFIG_INVALID, `Invalid SearchResultPayload: "${fieldLabel}.sortValues" must be an array or null`)
    }
    if (value.sortValues.length > MAX_SORT_VALUES) {
      throwInvalid(
        CONFIG_INVALID,
        `Invalid SearchResultPayload: "${fieldLabel}.sortValues" carries more than ${MAX_SORT_VALUES} values`,
        { length: value.sortValues.length, limit: MAX_SORT_VALUES },
      )
    }
    for (const sortValue of value.sortValues) {
      if (
        sortValue !== null &&
        typeof sortValue !== 'string' &&
        typeof sortValue !== 'boolean' &&
        !isFiniteNumber(sortValue)
      ) {
        throwInvalid(
          CONFIG_INVALID,
          `Invalid SearchResultPayload: "${fieldLabel}.sortValues" accepts a string, a finite number, a boolean, or null`,
        )
      }
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

function validateFacetErrorBounds(value: unknown): void {
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchResultPayload: "facetErrorBounds" must be an object or null')
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_FACET_FIELDS) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchResultPayload: "facetErrorBounds" exceeds maximum field count of ${MAX_FACET_FIELDS}`,
      { length: entries.length, limit: MAX_FACET_FIELDS },
    )
  }
  for (const [fieldName, bound] of entries) {
    if (!isInteger(bound) || bound < 0) {
      throwInvalid(
        CONFIG_INVALID,
        `Invalid SearchResultPayload: "facetErrorBounds.${fieldName}" must be a non-negative integer`,
      )
    }
  }
}

function validateGroupEntries(value: unknown): void {
  if (!Array.isArray(value)) {
    throwInvalid(CONFIG_INVALID, 'Invalid SearchResultPayload: "groups" must be an array or null')
  }
  if (value.length > MAX_GROUPS_PER_RESPONSE) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid SearchResultPayload: "groups" exceeds maximum length of ${MAX_GROUPS_PER_RESPONSE}`,
      { length: value.length, limit: MAX_GROUPS_PER_RESPONSE },
    )
  }
  for (let i = 0; i < value.length; i++) {
    const entry = value[i]
    if (!isRecord(entry) || !isRecord(entry.values)) {
      throwInvalid(CONFIG_INVALID, `Invalid SearchResultPayload: "groups[${i}]" must hold a values object`)
    }
    if (Object.keys(entry.values).length > MAX_FACET_FIELDS) {
      throwInvalid(
        CONFIG_INVALID,
        `Invalid SearchResultPayload: "groups[${i}].values" exceeds maximum field count of ${MAX_FACET_FIELDS}`,
      )
    }
    if (!Array.isArray(entry.scored)) {
      throwInvalid(CONFIG_INVALID, `Invalid SearchResultPayload: "groups[${i}].scored" must be an array`)
    }
    if (entry.scored.length > MAX_RESULTS_PER_PARTITION) {
      throwInvalid(
        CONFIG_INVALID,
        `Invalid SearchResultPayload: "groups[${i}].scored" exceeds maximum length of ${MAX_RESULTS_PER_PARTITION}`,
        { length: entry.scored.length, limit: MAX_RESULTS_PER_PARTITION },
      )
    }
    for (let j = 0; j < entry.scored.length; j++) {
      validateScoredEntry(entry.scored[j], `groups[${i}].scored[${j}]`)
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
  if (decoded.facetErrorBounds !== null && decoded.facetErrorBounds !== undefined) {
    validateFacetErrorBounds(decoded.facetErrorBounds)
  }
  if (decoded.groups !== null && decoded.groups !== undefined) {
    validateGroupEntries(decoded.groups)
  }
  return decoded as unknown as SearchResultPayload
}

export { MAX_RESULTS_PER_PARTITION }
