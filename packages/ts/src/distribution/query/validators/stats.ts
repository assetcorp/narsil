import { validateIndexName } from '../../cluster/index-metadata'
import type { GlobalStatistics, StatsPayload, StatsResultPayload } from '../../transport/types'
import {
  CONFIG_INVALID,
  isFiniteNumber,
  isInteger,
  isRecord,
  MAX_TERM_LENGTH,
  MAX_TERMS_COUNT,
  throwInvalid,
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

export function validateStatsPayload(decoded: unknown): StatsPayload {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid StatsPayload: expected an object')
  }
  validateIndexNameField(decoded.indexName, 'indexName')
  validatePartitionIdsArray(decoded.partitionIds, 'partitionIds', CONFIG_INVALID)
  validateStringArray(decoded.terms, 'terms', MAX_TERMS_COUNT, MAX_TERM_LENGTH, CONFIG_INVALID)
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
