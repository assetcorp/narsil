import { ErrorCodes, NarsilError } from '../errors'
import { MAX_RERANK_WINDOW } from '../rerank/constants'
import type { Narsil } from '../types/engine'
import { MAX_BODY_BYTES_IN_FLIGHT_FRACTION, MIN_COUNTED_SERVER_LIMIT, MIN_UNBOUNDED_SERVER_LIMIT } from './constants'
import type { ServerLimits } from './types'

const ENGINE_METHOD_SAMPLE = ['createIndex', 'listIndexes', 'insert', 'query', 'get', 'shutdown'] as const

const LIMITS_UNBOUNDED_AT_ZERO = [
  'maxBodyBytes',
  'maxImportBytes',
  'maxRestoreBytes',
  'maxLineBytes',
  'maxImportErrors',
  'maxConcurrentRequests',
  'maxConcurrentTasks',
] as const

const COUNTED_LIMITS = [
  'importBatchSize',
  'maxResultWindow',
  'maxRerankWindow',
  'maxFetchDocuments',
  'maxTaskPageSize',
] as const

export function assertServerEngine(engine: Narsil): void {
  const candidate: unknown = engine
  if (typeof candidate !== 'object' || candidate === null) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'The first argument to createServer must be the engine that createNarsil returns, with the options second',
      { received: candidate === null ? 'null' : typeof candidate },
    )
  }
  const members = candidate as Record<string, unknown>
  const missing = ENGINE_METHOD_SAMPLE.filter(method => typeof members[method] !== 'function')
  if (missing.length === 0) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `The first argument to createServer offers no ${missing.join(', ')}, so it is some value other than the engine that createNarsil returns`,
    { missing },
  )
}

function assertLimit(field: string, value: number | undefined, minimum: number): void {
  if (value === undefined) return
  if (Number.isInteger(value) && value >= minimum) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `limits.${field} must be a whole number of at least ${minimum}; however, this configuration sets it to ${String(value)}`,
    { field, value, minimum },
  )
}

function assertFraction(field: string, value: number | undefined): void {
  if (value === undefined) return
  if (Number.isFinite(value) && value >= 0 && value <= MAX_BODY_BYTES_IN_FLIGHT_FRACTION) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `limits.${field} must be a fraction from 0 to ${MAX_BODY_BYTES_IN_FLIGHT_FRACTION}; however, this configuration sets it to ${String(value)}`,
    { field, value, maximum: MAX_BODY_BYTES_IN_FLIGHT_FRACTION },
  )
}

function assertRerankWindowCap(value: number | undefined, engineCap: number | undefined): void {
  if (value === undefined) return
  const cap = Math.min(MAX_RERANK_WINDOW, engineCap ?? MAX_RERANK_WINDOW)
  if (value <= cap) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `limits.maxRerankWindow must be at most ${cap}, the largest window that the engine accepts; however, this configuration sets it to ${value}`,
    { field: 'maxRerankWindow', value, maximum: cap },
  )
}

export function assertServerLimits(limits: ServerLimits | undefined, engineRerankWindow?: number): void {
  if (limits === undefined) return
  for (const field of LIMITS_UNBOUNDED_AT_ZERO) assertLimit(field, limits[field], MIN_UNBOUNDED_SERVER_LIMIT)
  for (const field of COUNTED_LIMITS) assertLimit(field, limits[field], MIN_COUNTED_SERVER_LIMIT)
  assertFraction('maxBodyBytesInFlightFraction', limits.maxBodyBytesInFlightFraction)
  assertRerankWindowCap(limits.maxRerankWindow, engineRerankWindow)
}

export function assertAllowRegex(allowRegex: unknown): void {
  if (allowRegex === undefined || typeof allowRegex === 'boolean') return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `allowRegex must be true or false; however, this configuration sets it to ${String(allowRegex)}`,
    { field: 'allowRegex', value: String(allowRegex) },
  )
}
