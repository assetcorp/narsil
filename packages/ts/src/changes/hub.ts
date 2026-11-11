import { NarsilError, ServerErrorCodes } from '../errors'
import {
  DEFAULT_FEED_WINDOW_BYTES,
  DEFAULT_MAX_FEED_BUFFERED_BYTES,
  DEFAULT_MAX_FEED_CATCH_UPS,
  DEFAULT_MAX_FEED_CONNECTIONS,
} from '../sync/feed/constants'
import { createByteBudget, createSemaphore } from '../sync/feed/limits'
import type { FeedSocket } from '../sync/feed/session'
import type { FeedChange } from '../sync/feed/source'
import { changesNotEnabled } from './cursor'
import { ChangesSession } from './session'
import type { ChangeSource } from './source'
import { CHANGES_CLOSE_GOING_AWAY, CHANGES_CLOSE_RESYNC } from './wire'

export interface ChangesHubOptions {
  windowBytes?: number
  maxConnections?: number
  maxCatchUps?: number
  maxBufferedBytes?: number
  refuseFilter?(filter: unknown): Error | null
  onError?(error: unknown): void
}

export interface ChangesAdmission {
  open(socket: FeedSocket): ChangesSession
  cancel(): void
}

export interface ChangesHub {
  admit(indexName: string, expiresAt: number | null): ChangesAdmission
  connectionCount(): number
  close(): void
}

export function createChangesHub(source: ChangeSource, options: ChangesHubOptions = {}): ChangesHub {
  const windowBytes = options.windowBytes ?? DEFAULT_FEED_WINDOW_BYTES
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_FEED_CONNECTIONS
  const reads = createSemaphore(options.maxCatchUps ?? DEFAULT_MAX_FEED_CATCH_UPS)
  const buffered = createByteBudget(options.maxBufferedBytes ?? DEFAULT_MAX_FEED_BUFFERED_BYTES)
  const refuseFilter = options.refuseFilter ?? (() => null)
  const sessionsByIndex = new Map<string, Set<ChangesSession>>()
  const unwatchByIndex = new Map<string, () => void>()
  let connections = 0
  let stopListening: (() => void) | null = null
  let closed = false

  function each(indexName: string, action: (session: ChangesSession) => void): void {
    const sessions = sessionsByIndex.get(indexName)
    if (sessions === undefined) return
    for (const session of [...sessions]) action(session)
  }

  function onChange(change: FeedChange): void {
    switch (change.kind) {
      case 'advanced':
        each(change.indexName, session => session.advance())
        return
      case 'epoch':
        each(change.indexName, session => session.resync('epoch'))
        return
      case 'previous-document-off':
        each(change.indexName, session => session.previousDocumentOff())
        return
      case 'changes-off':
      case 'dropped':
        each(change.indexName, session => session.close(CHANGES_CLOSE_RESYNC, 'change capture is off'))
        return
      case 'off':
      case 'settings':
        return
    }
  }

  function release(): void {
    connections -= 1
    if (connections === 0 && stopListening !== null) {
      stopListening()
      stopListening = null
    }
  }

  function forget(session: ChangesSession): void {
    const sessions = sessionsByIndex.get(session.indexName)
    if (sessions === undefined || !sessions.delete(session)) return
    if (sessions.size === 0) {
      sessionsByIndex.delete(session.indexName)
      unwatchByIndex.get(session.indexName)?.()
      unwatchByIndex.delete(session.indexName)
    }
    release()
  }

  function open(indexName: string, expiresAt: number | null, socket: FeedSocket): ChangesSession {
    if (stopListening === null) stopListening = source.listen(onChange)
    const session = new ChangesSession({
      source,
      indexName,
      socket,
      windowBytes,
      expiresAt,
      reads,
      buffered,
      refuseFilter,
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
      if (source.changesState(indexName) === null) throw changesNotEnabled(indexName)
      if (connections >= maxConnections) {
        throw new NarsilError(
          ServerErrorCodes.TOO_MANY_REQUESTS,
          `The server holds ${connections} change feed connections, the most that it accepts`,
          { maximum: maxConnections },
        )
      }
      connections += 1
      let settled = false
      return {
        open(socket) {
          if (settled) throw new Error('A change feed admission opens one connection')
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
        each(indexName, session => session.close(CHANGES_CLOSE_GOING_AWAY, 'server closing'))
      }
      stopListening?.()
      stopListening = null
    },
  }
}
