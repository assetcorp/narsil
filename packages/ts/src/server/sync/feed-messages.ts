import type { SerializedError } from '../errors'

export interface FeedAdmitRequest {
  type: 'feed-admit'
  requestId: number
  indexName: string
  expiresAt: number | null
}

export interface FeedAdmittedReply {
  type: 'feed-admitted'
  requestId: number
  feedId: number | null
  error: SerializedError | null
}

export type ThreadFeedNote =
  | { type: 'feed-open'; feedId: number }
  | { type: 'feed-cancel'; feedId: number }
  | { type: 'feed-message'; feedId: number; bytes: Uint8Array; binary: boolean }
  | { type: 'feed-sent'; feedId: number; bytes: number; buffered: number }
  | { type: 'feed-closed'; feedId: number }

export type MainFeedNote =
  | { type: 'feed-send'; feedId: number; bytes: Uint8Array }
  | { type: 'feed-close'; feedId: number; code: number; reason: string }

const THREAD_FEED_NOTES: ReadonlySet<string> = new Set([
  'feed-open',
  'feed-cancel',
  'feed-message',
  'feed-sent',
  'feed-closed',
])

function typeAndFeedId(message: unknown): { type: unknown; feedId: unknown } | null {
  if (typeof message !== 'object' || message === null) return null
  const { type, feedId } = message as { type?: unknown; feedId?: unknown }
  return { type, feedId }
}

export function isThreadFeedNote(message: unknown): message is ThreadFeedNote {
  const fields = typeAndFeedId(message)
  return fields !== null && typeof fields.feedId === 'number' && THREAD_FEED_NOTES.has(String(fields.type))
}

export function isMainFeedNote(message: unknown): message is MainFeedNote {
  const fields = typeAndFeedId(message)
  return (
    fields !== null &&
    typeof fields.feedId === 'number' &&
    (fields.type === 'feed-send' || fields.type === 'feed-close')
  )
}

export function isFeedAdmitRequest(message: unknown): message is FeedAdmitRequest {
  if (typeof message !== 'object' || message === null) return false
  const { type, requestId, indexName } = message as { type?: unknown; requestId?: unknown; indexName?: unknown }
  return type === 'feed-admit' && typeof requestId === 'number' && typeof indexName === 'string'
}
