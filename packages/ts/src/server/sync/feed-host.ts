import type { MessagePort } from 'node:worker_threads'
import type { FeedAdmission, FeedHub } from '../../sync/feed/hub'
import type { FeedSession, FeedSocket } from '../../sync/feed/session'
import { toHttpError } from '../errors'
import type { Authorizer } from '../request'
import type { FeedAdmitRequest, FeedAdmittedReply, MainFeedNote, ThreadFeedNote } from './feed-messages'
import type { FeedGateway } from './feed-route'
import type { SyncServing } from './serving'

export interface ThreadFeeds {
  admit(request: FeedAdmitRequest): Promise<FeedAdmittedReply>
  handle(note: ThreadFeedNote): void
  closeAll(): void
}

export interface FeedHost {
  gateway: FeedGateway
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
  admission: FeedAdmission
  socket: RelayedFeedSocket
  session: FeedSession | null
}

export function createFeedHost(hub: FeedHub, serving: SyncServing, authorize: Authorizer | undefined): FeedHost {
  async function admit(indexName: string, expiresAt: number | null): Promise<FeedAdmission> {
    await serving.admitFeed(indexName)
    return hub.admit(indexName, expiresAt)
  }

  const gateway: FeedGateway = {
    authorize: context =>
      authorize === undefined ? Promise.resolve({ allowed: true, expiresAt: null }) : authorize(context),
    async admit(indexName, expiresAt) {
      const admission = await admit(indexName, expiresAt)
      return { open: socket => admission.open(socket), cancel: () => admission.cancel() }
    },
  }

  function forThread(port: MessagePort): ThreadFeeds {
    const feeds = new Map<number, RelayedFeed>()
    let nextFeedId = 0
    let closed = false

    function closeFeed(feedId: number): void {
      const feed = feeds.get(feedId)
      if (feed === undefined) return
      feeds.delete(feedId)
      feed.socket.markClosed()
      if (feed.session === null) feed.admission.cancel()
      else feed.session.closedByPeer()
    }

    return {
      async admit(request) {
        try {
          const admission = await admit(request.indexName, request.expiresAt)
          if (closed) {
            admission.cancel()
            return { type: 'feed-admitted', requestId: request.requestId, feedId: null, error: null }
          }
          nextFeedId += 1
          const feedId = nextFeedId
          feeds.set(feedId, { admission, socket: new RelayedFeedSocket(port, feedId), session: null })
          return { type: 'feed-admitted', requestId: request.requestId, feedId, error: null }
        } catch (err) {
          return { type: 'feed-admitted', requestId: request.requestId, feedId: null, error: toHttpError(err).body }
        }
      },

      handle(note) {
        const feed = feeds.get(note.feedId)
        if (feed === undefined) return
        switch (note.type) {
          case 'feed-open':
            if (feed.session === null) feed.session = feed.admission.open(feed.socket)
            return
          case 'feed-message':
            feed.session?.receive(note.bytes, note.binary)
            return
          case 'feed-sent':
            feed.socket.sent(note.bytes, note.buffered)
            feed.session?.drained()
            return
          case 'feed-cancel':
          case 'feed-closed':
            closeFeed(note.feedId)
            return
        }
      },

      closeAll() {
        closed = true
        for (const feedId of [...feeds.keys()]) closeFeed(feedId)
      },
    }
  }

  return { gateway, forThread, close: () => hub.close() }
}
