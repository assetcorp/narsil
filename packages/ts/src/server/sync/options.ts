import { ErrorCodes, NarsilError } from '../../errors'
import {
  DEFAULT_FEED_WINDOW_BYTES,
  DEFAULT_MAX_FEED_BUFFERED_BYTES,
  DEFAULT_MAX_FEED_CATCH_UPS,
  DEFAULT_MAX_FEED_CONNECTIONS,
} from '../../sync/feed/constants'
import type { ServerChangesOptions, ServerOptions, ServerSyncOptions } from '../types'
import type { FeedKind } from './feed-messages'

export interface ResolvedFeedOptions {
  windowBytes: number
  maxConnections: number
  maxCatchUps: number
  maxBufferedBytes: number
}

const FEED_OPTION_FIELDS = ['windowBytes', 'maxConnections', 'maxCatchUps', 'maxBufferedBytes'] as const

const FEED_REFUSALS: Record<FeedKind, string> = {
  sync: 'Refusing to start: the device sync routes are on with no onRequest hook. A device receives the whole index, so set options.onRequest to admit only the user whose documents the index holds. allowInsecure does not lift this refusal.',
  changes:
    'Refusing to start: the change feed is on with no onRequest hook. A subscriber receives every document of the index, so set options.onRequest to admit only the services that may read the whole index. allowInsecure does not lift this refusal.',
}

function assertCount(feed: FeedKind, field: string, value: unknown): void {
  if (value === undefined) return
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `${feed}.${field} must be a whole number of at least 1; however, this configuration sets it to ${String(value)}`,
    { field, value: String(value) },
  )
}

export function resolveFeedOptions(
  feed: FeedKind,
  value: ServerOptions['sync'] | ServerOptions['changes'],
): ResolvedFeedOptions | null {
  if (value === undefined || value === false) return null
  if (value !== true && (typeof value !== 'object' || value === null)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `${feed} must be true, false, or an object of settings; however, this configuration sets it to ${String(value)}`,
      { field: feed, value: String(value) },
    )
  }
  const settings: ServerSyncOptions | ServerChangesOptions = value === true ? {} : value
  for (const field of FEED_OPTION_FIELDS) assertCount(feed, field, settings[field])
  return {
    windowBytes: settings.windowBytes ?? DEFAULT_FEED_WINDOW_BYTES,
    maxConnections: settings.maxConnections ?? DEFAULT_MAX_FEED_CONNECTIONS,
    maxCatchUps: settings.maxCatchUps ?? DEFAULT_MAX_FEED_CATCH_UPS,
    maxBufferedBytes: settings.maxBufferedBytes ?? DEFAULT_MAX_FEED_BUFFERED_BYTES,
  }
}

export function assertFeedHasAuthentication(
  feed: FeedKind,
  resolved: ResolvedFeedOptions | null,
  options: ServerOptions,
): void {
  if (resolved === null || options.onRequest !== undefined) return
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, FEED_REFUSALS[feed], { field: feed })
}
