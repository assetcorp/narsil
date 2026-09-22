import { ErrorCodes, NarsilError } from '../errors'
import type { Narsil } from '../types/engine'
import { MIN_COUNTED_SERVER_LIMIT, MIN_UNBOUNDED_SERVER_LIMIT } from './constants'
import type { ServerLimits } from './types'

const ENGINE_METHOD_SAMPLE = ['createIndex', 'listIndexes', 'insert', 'query', 'get', 'shutdown'] as const

const LIMITS_UNBOUNDED_AT_ZERO = [
  'maxBodyBytes',
  'maxImportBytes',
  'maxLineBytes',
  'maxImportErrors',
  'maxConcurrentRequests',
  'maxConcurrentTasks',
] as const

const COUNTED_LIMITS = ['importBatchSize', 'maxResultWindow', 'maxFetchDocuments', 'maxTaskPageSize'] as const

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

export function assertServerLimits(limits: ServerLimits | undefined): void {
  if (limits === undefined) return
  for (const field of LIMITS_UNBOUNDED_AT_ZERO) assertLimit(field, limits[field], MIN_UNBOUNDED_SERVER_LIMIT)
  for (const field of COUNTED_LIMITS) assertLimit(field, limits[field], MIN_COUNTED_SERVER_LIMIT)
}
