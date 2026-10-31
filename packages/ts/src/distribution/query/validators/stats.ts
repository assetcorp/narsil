import { validateIndexName } from '../../cluster/index-metadata'
import type { GlobalStatistics, StatsPayload, StatsResultPayload } from '../../transport/types'
import {
  MAX_FIELD_NAME_LENGTH,
  MAX_FIELDS_LIST,
  MAX_PREFIX_LENGTH,
  MAX_STATS_TOKENS,
  MAX_TERM_LENGTH,
  MAX_TERMS_COUNT,
  MAX_TOLERANCE,
} from '../constants'
import {
  CONFIG_INVALID,
  isFiniteNumber,
  isInteger,
  isRecord,
  throwInvalid,
  validateAnalysisGeneration,
  validatePartitionIdsArray,
  validateStringArray,
} from './common'

function validateIndexNameField(value: unknown, fieldLabel: string): string {
  if (typeof value !== 'string') {
    throwInvalid(CONFIG_INVALID, `Invalid StatsPayload: "${fieldLabel}" must be a string`)
  }
  validateIndexName(value)
  return value
}

function validateNumericRecord(value: unknown, fieldLabel: string): void {
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, `Invalid payload: "${fieldLabel}" must be an object`)
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length === 0) {
      throwInvalid(CONFIG_INVALID, `Invalid payload: each "${fieldLabel}" key must be a non-empty string`)
    }
    if (!isFiniteNumber(entry) || (entry as number) < 0) {
      throwInvalid(CONFIG_INVALID, `Invalid payload: "${fieldLabel}.${key}" must be a non-negative finite number`)
    }
  }
}

function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined
}

function validateTokenList(value: unknown, fieldLabel: string): void {
  if (!Array.isArray(value)) {
    throwInvalid(CONFIG_INVALID, `Invalid payload: "${fieldLabel}" must be an array or absent`)
  }
  if (value.length > MAX_STATS_TOKENS) {
    throwInvalid(CONFIG_INVALID, `Invalid payload: "${fieldLabel}" exceeds maximum length of ${MAX_STATS_TOKENS}`, {
      length: value.length,
      limit: MAX_STATS_TOKENS,
    })
  }
  for (const token of value) {
    if (typeof token !== 'string' || token.length === 0) {
      throwInvalid(CONFIG_INVALID, `Invalid payload: each "${fieldLabel}" entry must be a non-empty string`)
    }
  }
}

function validateBoundedInteger(value: unknown, fieldLabel: string, max: number): void {
  if (!isAbsent(value) && (!isInteger(value) || value < 0 || value > max)) {
    throwInvalid(CONFIG_INVALID, `Invalid StatsPayload: "${fieldLabel}" must be a non-negative integer at most ${max}`)
  }
}

function validateExpansion(value: unknown): void {
  if (isAbsent(value)) return
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, 'Invalid StatsPayload: "expansion" must be an object or absent')
  }
  validateBoundedInteger(value.tolerance, 'expansion.tolerance', MAX_TOLERANCE)
  validateBoundedInteger(value.prefixLength, 'expansion.prefixLength', MAX_PREFIX_LENGTH)
  for (const flag of ['prefix', 'partialWords', 'exact'] as const) {
    if (!isAbsent(value[flag]) && typeof value[flag] !== 'boolean') {
      throwInvalid(CONFIG_INVALID, `Invalid StatsPayload: "expansion.${flag}" must be a boolean or absent`)
    }
  }
  if (!isAbsent(value.fields)) {
    validateStringArray(value.fields, 'expansion.fields', MAX_FIELDS_LIST, MAX_FIELD_NAME_LENGTH, CONFIG_INVALID)
  }
}

export function validateStatsPayload(decoded: unknown): StatsPayload {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid StatsPayload: expected an object')
  }
  validateIndexNameField(decoded.indexName, 'indexName')
  validatePartitionIdsArray(decoded.partitionIds, 'partitionIds', CONFIG_INVALID)
  validateStringArray(decoded.terms, 'terms', MAX_TERMS_COUNT, MAX_TERM_LENGTH, CONFIG_INVALID)
  validateExpansion(decoded.expansion)
  if (!isAbsent(decoded.tokens)) validateTokenList(decoded.tokens, 'StatsPayload.tokens')
  validateAnalysisGeneration(decoded.analysisGeneration, 'StatsPayload')
  return decoded as unknown as StatsPayload
}

export function validateStatsResultPayload(decoded: unknown): StatsResultPayload {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid StatsResultPayload: expected an object')
  }
  if (!isInteger(decoded.totalDocuments) || decoded.totalDocuments < 0) {
    throwInvalid(CONFIG_INVALID, 'Invalid StatsResultPayload: "totalDocuments" must be a non-negative integer')
  }
  validateNumericRecord(decoded.docFrequencies, 'StatsResultPayload.docFrequencies')
  validateNumericRecord(decoded.totalFieldLengths, 'StatsResultPayload.totalFieldLengths')
  if (!isAbsent(decoded.expanded)) validateTokenList(decoded.expanded, 'StatsResultPayload.expanded')
  return decoded as unknown as StatsResultPayload
}

export function validateGlobalStatistics(decoded: unknown): GlobalStatistics {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid GlobalStatistics: expected an object')
  }
  if (!isFiniteNumber(decoded.totalDocuments) || decoded.totalDocuments < 0) {
    throwInvalid(CONFIG_INVALID, 'Invalid GlobalStatistics: "totalDocuments" must be a non-negative finite number')
  }
  validateNumericRecord(decoded.docFrequencies, 'GlobalStatistics.docFrequencies')
  validateNumericRecord(decoded.totalFieldLengths, 'GlobalStatistics.totalFieldLengths')
  validateNumericRecord(decoded.averageFieldLengths, 'GlobalStatistics.averageFieldLengths')
  return decoded as unknown as GlobalStatistics
}
