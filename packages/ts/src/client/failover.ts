import { ClientErrorCodes, ErrorCodes, NarsilError } from '../errors'
import { DEFAULT_MAX_URL_SKIP_MS, DEFAULT_URL_SKIP_MS } from './constants'

const UNSENT_CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ConnectionRefused'])
const MAX_CAUSE_DEPTH = 4
const SKIP_DOUBLING_CEILING = 30
const RETRIED_STATUSES = new Set([502, 503, 504])

export interface UrlEntry {
  readonly base: string
  readonly position: number
  refusals: number
  skipUntil: number
}

export interface UrlPool {
  order(now: number): UrlEntry[]
  took(entry: UrlEntry): void
  answered(entry: UrlEntry): void
  refused(entry: UrlEntry, now: number): void
}

export interface UrlPoolOptions {
  urlSkipMs?: number
  maxUrlSkipMs?: number
}

function readSkip(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `"${field}" must be a whole number of milliseconds, 0 or more`, {
      [field]: value,
    })
  }
  return value
}

export function createUrlPool(bases: string[], options: UrlPoolOptions): UrlPool {
  const skipMs = readSkip(options.urlSkipMs, DEFAULT_URL_SKIP_MS, 'urlSkipMs')
  const maxSkipMs = readSkip(options.maxUrlSkipMs, Math.max(DEFAULT_MAX_URL_SKIP_MS, skipMs), 'maxUrlSkipMs')
  if (maxSkipMs < skipMs) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, '"maxUrlSkipMs" must be at least "urlSkipMs"', {
      urlSkipMs: skipMs,
      maxUrlSkipMs: maxSkipMs,
    })
  }
  const entries: UrlEntry[] = bases.map((base, position) => ({ base, position, refusals: 0, skipUntil: 0 }))
  let nextStart = 0

  return {
    order(now) {
      const rotation = [...entries.slice(nextStart), ...entries.slice(0, nextStart)]
      const open = rotation.filter(entry => entry.skipUntil <= now)
      const skipped = rotation.filter(entry => entry.skipUntil > now).sort((a, b) => a.skipUntil - b.skipUntil)
      return [...open, ...skipped]
    },
    took(entry) {
      nextStart = (entry.position + 1) % entries.length
    },
    answered(entry) {
      entry.refusals = 0
      entry.skipUntil = 0
    },
    refused(entry, now) {
      entry.refusals += 1
      const doublings = Math.min(entry.refusals - 1, SKIP_DOUBLING_CEILING)
      entry.skipUntil = now + Math.min(skipMs * 2 ** doublings, maxSkipMs)
    },
  }
}

export function failedBeforeSending(error: unknown, depth = 0): boolean {
  if (depth > MAX_CAUSE_DEPTH || typeof error !== 'object' || error === null) return false
  const { code, cause, errors } = error as { code?: unknown; cause?: unknown; errors?: unknown }
  if (typeof code === 'string' && UNSENT_CONNECTION_CODES.has(code)) return true
  if (failedBeforeSending(cause, depth + 1)) return true
  return Array.isArray(errors) && errors.length > 0 && errors.every(entry => failedBeforeSending(entry, depth + 1))
}

export function answersUnavailable(status: number): boolean {
  return RETRIED_STATUSES.has(status)
}

export function movesOnAfterAnswer(status: number, code: string | undefined, repeatable: boolean): boolean {
  if (!answersUnavailable(status)) return false
  return repeatable || code === ErrorCodes.NODE_NOT_READY
}

export function movesOnAfterFailure(failure: NarsilError, sentNothing: boolean, repeatable: boolean): boolean {
  if (failure.code === ClientErrorCodes.CLIENT_REQUEST_TIMEOUT) return repeatable
  if (failure.code === ClientErrorCodes.CLIENT_CONNECTION_FAILED) return repeatable || sentNothing
  return false
}
