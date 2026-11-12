import type { MessagePort } from 'node:worker_threads'
import { NarsilError, ServerErrorCodes } from '../../errors'
import type { FeedSocket } from '../../sync/feed/session'
import { toHttpError } from '../errors'
import type { Authorizer } from '../request'
import type { FeedAdmitRequest, FeedAdmittedReply, FeedKind, MainFeedNote, ThreadFeedNote } from './feed-messages'
import type { FeedEndpoint, FeedGateway } from './feed-route'

export interface ThreadFeeds {
  admit(request: FeedAdmitRequest): Promise<FeedAdmittedReply>
  handle(note: ThreadFeedNote): void
  closeAll(): void
}

export interface HostedAdmission {
  open(socket: FeedSocket): FeedEndpoint
  cancel(): void
}

export interface HostedFeed {
  admit(indexName: string, expiresAt: number | null): Promise<HostedAdmission>
  close(): void
}

export interface FeedHost {
  gateways: Partial<Record<FeedKind, FeedGateway>>
  forThread(port: MessagePort): ThreadFeeds
  close(): void
}

class RelayedFeedSocket implements FeedSocket {
  private inTransit = 0
  private threadBuffered = 0
  private closed = false

  constructor(
    private readonly port: MessagePort,
    private readonly feedId: number,
  ) {}

  send(bytes: Uint8Array): void {
    if (this.closed) return
    const copy = bytes.slice()
    this.inTransit += copy.byteLength
    this.post({ type: 'feed-send', feedId: this.feedId, bytes: copy }, [copy.buffer])
  }

  bufferedAmount(): number {
    return this.inTransit + this.threadBuffered
  }

  close(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    this.post({ type: 'feed-close', feedId: this.feedId, code, reason }, [])
  }

  sent(bytes: number, buffered: number): void {
    this.inTransit = Math.max(0, this.inTransit - bytes)
    this.threadBuffered = buffered
  }

  markClosed(): void {
    this.closed = true
  }

  private post(note: MainFeedNote, transfer: ArrayBuffer[]): void {
    try {
      this.port.postMessage(note, transfer)
    } catch {
      this.closed = true
    }
  }
}

interface RelayedFeed {
  admission: HostedAdmission
  socket: RelayedFeedSocket
  endpoint: FeedEndpoint | null
}

function routeMissing(): NarsilError {
  return new NarsilError(ServerErrorCodes.NOT_FOUND, 'Route not found')
}

export function createFeedHost(
  feeds: Partial<Record<FeedKind, HostedFeed>>,
  authorize: Authorizer | undefined,
): FeedHost {
  const authorizeContext: FeedGateway['authorize'] = context =>
    authorize === undefined ? Promise.resolve({ allowed: true, expiresAt: null }) : authorize(context)

  function admit(feed: FeedKind, indexName: string, expiresAt: number | null): Promise<HostedAdmission> {
    const hosted = feeds[feed]
    if (hosted === undefined) return Promise.reject(routeMissing())
    return hosted.admit(indexName, expiresAt)
  }

  const gateways: Partial<Record<FeedKind, FeedGateway>> = {}
  for (const feed of Object.keys(feeds) as FeedKind[]) {
    gateways[feed] = {
      authorize: authorizeContext,
      async admit(indexName, expiresAt) {
        const admission = await admit(feed, indexName, expiresAt)
        return { open: socket => admission.open(socket), cancel: () => admission.cancel() }
      },
    }
  }

  function forThread(port: MessagePort): ThreadFeeds {
    const relayed = new Map<number, RelayedFeed>()
    let nextFeedId = 0
    let closed = false

    function closeFeed(feedId: number): void {
      const feed = relayed.get(feedId)
      if (feed === undefined) return
      relayed.delete(feedId)
      feed.socket.markClosed()
      if (feed.endpoint === null) feed.admission.cancel()
      else feed.endpoint.closedByPeer()
    }

    return {
      async admit(request) {
        try {
          const admission = await admit(request.feed, request.indexName, request.expiresAt)
          if (closed) {
            admission.cancel()
            return { type: 'feed-admitted', requestId: request.requestId, feedId: null, error: null }
          }
          nextFeedId += 1
          const feedId = nextFeedId
          relayed.set(feedId, { admission, socket: new RelayedFeedSocket(port, feedId), endpoint: null })
          return { type: 'feed-admitted', requestId: request.requestId, feedId, error: null }
        } catch (err) {
          return { type: 'feed-admitted', requestId: request.requestId, feedId: null, error: toHttpError(err).body }
        }
      },

      handle(note) {
        const feed = relayed.get(note.feedId)
        if (feed === undefined) return
        switch (note.type) {
          case 'feed-open':
            if (feed.endpoint === null) feed.endpoint = feed.admission.open(feed.socket)
            return
          case 'feed-message':
            feed.endpoint?.receive(note.bytes, note.binary)
            return
          case 'feed-sent':
            feed.socket.sent(note.bytes, note.buffered)
            feed.endpoint?.drained()
            return
          case 'feed-cancel':
          case 'feed-closed':
            closeFeed(note.feedId)
            return
        }
      },

      closeAll() {
        closed = true
        for (const feedId of [...relayed.keys()]) closeFeed(feedId)
      },
    }
  }

  return {
    gateways,
    forThread,
    close() {
      for (const hosted of Object.values(feeds)) hosted?.close()
    },
  }
}
