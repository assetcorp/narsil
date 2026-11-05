import { ErrorCodes, NarsilError } from '../../errors'
import {
  DEFAULT_FEED_WINDOW_BYTES,
  DEFAULT_MAX_FEED_BUFFERED_BYTES,
  DEFAULT_MAX_FEED_CATCH_UPS,
  DEFAULT_MAX_FEED_CONNECTIONS,
} from '../../sync/feed/constants'
import type { ServerOptions, ServerSyncOptions } from '../types'

export interface ResolvedSyncOptions {
  windowBytes: number
  maxConnections: number
  maxCatchUps: number
  maxBufferedBytes: number
}

const SYNC_OPTION_FIELDS = ['windowBytes', 'maxConnections', 'maxCatchUps', 'maxBufferedBytes'] as const

function assertCount(field: string, value: unknown): void {
  if (value === undefined) return
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `sync.${field} must be a whole number of at least 1; however, this configuration sets it to ${String(value)}`,
    { field, value: String(value) },
  )
}

export function resolveSyncOptions(sync: ServerOptions['sync']): ResolvedSyncOptions | null {
  if (sync === undefined || sync === false) return null
  if (sync !== true && (typeof sync !== 'object' || sync === null)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `sync must be true, false, or an object of settings; however, this configuration sets it to ${String(sync)}`,
      { field: 'sync', value: String(sync) },
    )
  }
  const settings: ServerSyncOptions = sync === true ? {} : sync
  for (const field of SYNC_OPTION_FIELDS) assertCount(field, settings[field])
  return {
    windowBytes: settings.windowBytes ?? DEFAULT_FEED_WINDOW_BYTES,
    maxConnections: settings.maxConnections ?? DEFAULT_MAX_FEED_CONNECTIONS,
    maxCatchUps: settings.maxCatchUps ?? DEFAULT_MAX_FEED_CATCH_UPS,
    maxBufferedBytes: settings.maxBufferedBytes ?? DEFAULT_MAX_FEED_BUFFERED_BYTES,
  }
}

export function assertSyncHasAuthentication(sync: ResolvedSyncOptions | null, options: ServerOptions): void {
  if (sync === null || options.onRequest !== undefined) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    'Refusing to start: the device sync routes are on with no onRequest hook. A device receives the whole index, so set options.onRequest to admit only the user whose documents the index holds. allowInsecure does not lift this refusal.',
    { field: 'sync' },
  )
}
