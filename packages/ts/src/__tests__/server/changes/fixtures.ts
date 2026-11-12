import { decode, encode } from '@msgpack/msgpack'
import type { RequestContext, RequestDenial, RequestGrant } from '../../../server'

export const CHANGES_SUBPROTOCOL = 'narsil.changes.v1'
export const READER_TOKEN = 'reader-token'
export const OUTSIDER_TOKEN = 'outsider-token'

export interface ReaderHook {
  hook(ctx: RequestContext): RequestDenial | RequestGrant | undefined
  expiresAt: number | null
}

function credentialOf(ctx: RequestContext): string | null {
  const bearer = ctx.headers.authorization
  if (bearer?.startsWith('Bearer ')) return bearer.slice('Bearer '.length)
  const offered = (ctx.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim())
  return offered.length > 1 && offered[0] === CHANGES_SUBPROTOCOL ? (offered[1] ?? null) : null
}

export function readerHook(admitted: readonly string[] = [READER_TOKEN]): ReaderHook {
  const state: ReaderHook = {
    expiresAt: null,
    hook(ctx) {
      const credential = credentialOf(ctx)
      if (credential === null || !admitted.includes(credential)) {
        return { status: 403, code: 'FORBIDDEN', message: 'This credential may not read the index' }
      }
      return state.expiresAt === null ? undefined : { expiresAt: state.expiresAt }
    },
  }
  return state
}

export type FeedMessage = Record<string, unknown> & { type: string }

export interface RawChangesFeed {
  protocol: string
  send(message: unknown): void
  sendRaw(bytes: Uint8Array | string): void
  received: FeedMessage[]
  receivedBytes(): number
  next(type: string, timeoutMs?: number): Promise<FeedMessage>
  closed: Promise<{ code: number; reason: string }>
  close(): void
}

export function openRawChangesFeed(base: string, index: string, token: string): Promise<RawChangesFeed> {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/indexes/${index}/changes/feed`, [
    CHANGES_SUBPROTOCOL,
    token,
  ])
  socket.binaryType = 'arraybuffer'
  const received: FeedMessage[] = []
  let bytes = 0
  let consumed = 0
  const waiters: Array<() => void> = []
  const closed = new Promise<{ code: number; reason: string }>(resolve => {
    socket.addEventListener('close', event => {
      resolve({ code: event.code, reason: event.reason })
      for (const wake of waiters.splice(0)) wake()
    })
  })
  socket.addEventListener('message', event => {
    const data = new Uint8Array(event.data as ArrayBuffer)
    bytes += data.byteLength
    received.push(decode(data) as FeedMessage)
    for (const wake of waiters.splice(0)) wake()
  })
  const feed: RawChangesFeed = {
    get protocol() {
      return socket.protocol
    },
    send: message => socket.send(encode(message, { ignoreUndefined: true })),
    sendRaw: raw => socket.send(raw),
    received,
    receivedBytes: () => bytes,
    async next(type, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        for (let at = consumed; at < received.length; at++) {
          if (received[at]?.type === type) {
            consumed = at + 1
            return received[at] as FeedMessage
          }
        }
        if (socket.readyState === WebSocket.CLOSED) throw new Error(`The feed closed before a ${type} message`)
        if (Date.now() > deadline) throw new Error(`No ${type} message within ${timeoutMs} ms`)
        await new Promise<void>(resolve => {
          waiters.push(resolve)
          setTimeout(resolve, 50)
        })
      }
    },
    closed,
    close: () => socket.close(),
  }
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(feed))
    socket.addEventListener('error', () => reject(new Error('The feed upgrade failed')))
  })
}

export async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`The condition did not hold within ${timeoutMs} ms`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
