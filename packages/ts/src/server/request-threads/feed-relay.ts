import type { MessagePort } from 'node:worker_threads'
import { ErrorCodes, NarsilError } from '../../errors'
import type { FeedSocket } from '../../sync/feed/session'
import { SYNC_CLOSE_GOING_AWAY } from '../../sync/protocol'
import { type FeedKind, isMainFeedNote, type ThreadFeedNote } from '../sync/feed-messages'
import type { FeedGateway } from '../sync/feed-route'
import type { RelayClient } from './relay-client'

export interface ThreadFeedGateway extends FeedGateway {
  close(): void
}

export function threadFeedGateway(port: MessagePort, relay: RelayClient, feed: FeedKind): ThreadFeedGateway {
  const sockets = new Map<number, FeedSocket>()

  function post(note: ThreadFeedNote, transfer: ArrayBuffer[] = []): void {
    try {
      port.postMessage(note, transfer)
    } catch {}
  }

  const onMessage = (message: unknown): void => {
    if (!isMainFeedNote(message)) return
    const socket = sockets.get(message.feedId)
    if (socket === undefined) return
    if (message.type === 'feed-close') {
      sockets.delete(message.feedId)
      socket.close(message.code, message.reason)
      return
    }
    socket.send(message.bytes)
    post({
      type: 'feed-sent',
      feedId: message.feedId,
      bytes: message.bytes.byteLength,
      buffered: socket.bufferedAmount(),
    })
  }
  port.on('message', onMessage)

  return {
    authorize: context => relay.authorize(context),

    async admit(indexName, expiresAt) {
      const reply = await relay.admitFeed(feed, indexName, expiresAt)
      const { feedId } = reply
      if (feedId === null) {
        const error = reply.error
        if (error === null) throw new NarsilError(ErrorCodes.WORKER_CRASHED, 'The server is closing its feeds')
        throw new NarsilError(error.code as never, error.message, error.details)
      }
      return {
        open(socket) {
          sockets.set(feedId, socket)
          post({ type: 'feed-open', feedId })
          return {
            receive(bytes, binary) {
              const copy =
                bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()
              post({ type: 'feed-message', feedId, bytes: copy, binary }, [copy.buffer as ArrayBuffer])
            },
            drained() {
              post({ type: 'feed-sent', feedId, bytes: 0, buffered: socket.bufferedAmount() })
            },
            closedByPeer() {
              sockets.delete(feedId)
              post({ type: 'feed-closed', feedId })
            },
          }
        },
        cancel() {
          post({ type: 'feed-cancel', feedId })
        },
      }
    },

    close() {
      port.off('message', onMessage)
      for (const [feedId, socket] of sockets) {
        socket.close(SYNC_CLOSE_GOING_AWAY, 'server closing')
        post({ type: 'feed-closed', feedId })
      }
      sockets.clear()
    },
  }
}
