import { ErrorCodes, NarsilError, ServerErrorCodes } from '../../errors'
import { SYNC_CLOSE_GOING_AWAY, SYNC_CLOSE_RESYNC } from '../protocol'
import {
  DEFAULT_FEED_WINDOW_BYTES,
  DEFAULT_MAX_FEED_BUFFERED_BYTES,
  DEFAULT_MAX_FEED_CATCH_UPS,
  DEFAULT_MAX_FEED_CONNECTIONS,
} from './constants'
import { createByteBudget, createSemaphore } from './limits'
import { FeedSession, type FeedSocket } from './session'
import type { FeedChange, FeedSource } from './source'

export interface FeedHubOptions {
  windowBytes?: number
  maxConnections?: number
  maxCatchUps?: number
  maxBufferedBytes?: number
  onError?(error: unknown): void
}

export interface FeedAdmission {
  open(socket: FeedSocket): FeedSession
  cancel(): void
}

export interface FeedHub {
  admit(indexName: string, expiresAt: number | null): FeedAdmission
  connectionCount(): number
  close(): void
}

export function createFeedHub(source: FeedSource, options: FeedHubOptions = {}): FeedHub {
  const windowBytes = options.windowBytes ?? DEFAULT_FEED_WINDOW_BYTES
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_FEED_CONNECTIONS
  const reads = createSemaphore(options.maxCatchUps ?? DEFAULT_MAX_FEED_CATCH_UPS)
  const buffered = createByteBudget(options.maxBufferedBytes ?? DEFAULT_MAX_FEED_BUFFERED_BYTES)
  const sessionsByIndex = new Map<string, Set<FeedSession>>()
  const unwatchByIndex = new Map<string, () => void>()
  let connections = 0
  let stopListening: (() => void) | null = null
  let closed = false

  function each(indexName: string, action: (session: FeedSession) => void): void {
    const sessions = sessionsByIndex.get(indexName)
    if (sessions === undefined) return
    for (const session of [...sessions]) action(session)
  }

  function onChange(change: FeedChange): void {
    switch (change.kind) {
      case 'advanced':
        each(change.indexName, session => session.advance())
        return
      case 'settings':
        each(change.indexName, session => session.sendSettings())
        return
      case 'epoch':
        each(change.indexName, session => session.resync('epoch'))
        return
      case 'off':
      case 'dropped':
        each(change.indexName, session => session.close(SYNC_CLOSE_RESYNC, 'sync is off'))
        return
    }
  }

  function forget(session: FeedSession): void {
    const sessions = sessionsByIndex.get(session.indexName)
    if (sessions === undefined || !sessions.delete(session)) return
    if (sessions.size === 0) {
      sessionsByIndex.delete(session.indexName)
      unwatchByIndex.get(session.indexName)?.()
      unwatchByIndex.delete(session.indexName)
    }
    release()
  }

  function release(): void {
    connections -= 1
    if (connections === 0 && stopListening !== null) {
      stopListening()
      stopListening = null
    }
  }

  function open(indexName: string, expiresAt: number | null, socket: FeedSocket): FeedSession {
    if (stopListening === null) stopListening = source.listen(onChange)
    const session = new FeedSession({
      source,
      indexName,
      socket,
      windowBytes,
      expiresAt,
      reads,
      buffered,
      onClosed: forget,
      onError: error => options.onError?.(error),
    })
    let sessions = sessionsByIndex.get(indexName)
    if (sessions === undefined) {
      sessions = new Set()
      sessionsByIndex.set(indexName, sessions)
      const unwatch = source.watchIndex?.(indexName)
      if (unwatch !== undefined) unwatchByIndex.set(indexName, unwatch)
    }
    sessions.add(session)
    return session
  }

  return {
    admit(indexName, expiresAt) {
      if (closed) {
        throw new NarsilError(ServerErrorCodes.TOO_MANY_REQUESTS, 'The server is closing its feed connections')
      }
      if (source.indexState(indexName) === null) {
        throw new NarsilError(ErrorCodes.SYNC_NOT_ENABLED, `Index "${indexName}" has device sync off`, { indexName })
      }
      if (connections >= maxConnections) {
        throw new NarsilError(
          ServerErrorCodes.TOO_MANY_REQUESTS,
          `The server holds ${connections} feed connections, the most that it accepts`,
          { maximum: maxConnections },
        )
      }
      connections += 1
      let settled = false
      return {
        open(socket) {
          if (settled) throw new Error('A feed admission opens one connection')
          settled = true
          return open(indexName, expiresAt, socket)
        },
        cancel() {
          if (settled) return
          settled = true
          release()
        },
      }
    },

    connectionCount: () => connections,

    close() {
      closed = true
      for (const indexName of [...sessionsByIndex.keys()]) {
        each(indexName, session => session.close(SYNC_CLOSE_GOING_AWAY, 'server closing'))
      }
      stopListening?.()
      stopListening = null
    },
  }
}
