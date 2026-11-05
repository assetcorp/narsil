import { encode } from '@msgpack/msgpack'
import { ClientErrorCodes, ErrorCodes, NarsilError } from '../../errors'
import { type DeviceMessage, SYNC_SUBPROTOCOL } from '../protocol'
import { decodeFeedMessage, type FeedMessage } from './messages'

export interface FeedHandlers {
  onOpen(): void
  onMessage(message: FeedMessage): void
  onFailure(error: unknown): void
  onClose(code: number): void
}

export interface FeedConnection {
  send(message: DeviceMessage): void
  close(reason: string): void
}

const CLOSE_NORMAL = 1000

export function feedUrlOf(base: string, indexName: string): string {
  const location = (globalThis as { location?: { href?: string } }).location?.href
  let parsed: URL
  try {
    parsed = location === undefined ? new URL(base) : new URL(base, location)
  } catch {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `The device cannot read "${base}" as a server address`, {
      url: base,
    })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The device needs an http or https server address', { url: base })
  }
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/indexes/${encodeURIComponent(indexName)}/sync/feed`
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

function feedFailed(message: string): NarsilError {
  return new NarsilError(ClientErrorCodes.CLIENT_CONNECTION_FAILED, message)
}

export function openFeedConnection(url: string, credential: string | null, handlers: FeedHandlers): FeedConnection {
  if (typeof WebSocket === 'undefined') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Device sync needs a runtime with a global WebSocket')
  }
  const socket = new WebSocket(url, credential === null ? [SYNC_SUBPROTOCOL] : [SYNC_SUBPROTOCOL, credential])
  socket.binaryType = 'arraybuffer'
  let closed = false

  function finish(code: number): void {
    if (closed) return
    closed = true
    handlers.onClose(code)
  }

  function closeSocket(reason: string): void {
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close(CLOSE_NORMAL, reason)
    }
  }

  socket.onopen = () => {
    if (socket.protocol !== SYNC_SUBPROTOCOL) {
      handlers.onFailure(
        new NarsilError(
          ClientErrorCodes.CLIENT_INVALID_RESPONSE,
          `The server answered the feed with the subprotocol "${socket.protocol}"`,
        ),
      )
      closeSocket('subprotocol')
      finish(CLOSE_NORMAL)
      return
    }
    handlers.onOpen()
  }
  socket.onmessage = event => {
    if (closed) return
    if (!(event.data instanceof ArrayBuffer)) {
      handlers.onFailure(new NarsilError(ClientErrorCodes.CLIENT_INVALID_RESPONSE, 'The feed sent a text frame'))
      closeSocket('text frame')
      finish(CLOSE_NORMAL)
      return
    }
    let message: FeedMessage
    try {
      message = decodeFeedMessage(new Uint8Array(event.data))
    } catch (error) {
      handlers.onFailure(error)
      closeSocket('malformed message')
      finish(CLOSE_NORMAL)
      return
    }
    handlers.onMessage(message)
  }
  socket.onerror = () => {
    if (!closed) handlers.onFailure(feedFailed(`The feed at ${url} failed`))
  }
  socket.onclose = event => finish(event.code)

  return {
    send(message) {
      if (!closed && socket.readyState === WebSocket.OPEN) socket.send(encode(message))
    },
    close(reason) {
      closeSocket(reason)
      finish(CLOSE_NORMAL)
    },
  }
}
