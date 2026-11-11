import { request } from 'node:http'
import { decode, encode } from '@msgpack/msgpack'
import { createByteReader } from '../../../persistence/archive/byte-reader'
import { readSnapshotArchive } from '../../../persistence/archive/read'
import type { RequestContext, RequestDenial, RequestGrant } from '../../../server'

export const SUBPROTOCOL = 'narsil.sync.v1'
export const ADMIN_TOKEN = 'admin-token'

export interface Position {
  partitionId: number
  seqNo: number
}

export interface OwnerHook {
  hook(ctx: RequestContext): RequestDenial | RequestGrant | undefined
  expiresAt: number | null
}

const OWNERS: Readonly<Record<string, string>> = { 'alice-token': 'alice', 'bob-token': 'bob' }

function credentialOf(ctx: RequestContext): string | null {
  const bearer = ctx.headers.authorization
  if (bearer?.startsWith('Bearer ')) return bearer.slice('Bearer '.length)
  const offered = (ctx.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim())
  return offered.length > 1 && offered[0] === SUBPROTOCOL ? (offered[1] ?? null) : null
}

export function ownerHook(): OwnerHook {
  const state: OwnerHook = {
    expiresAt: null,
    hook(ctx) {
      const credential = credentialOf(ctx)
      if (credential === ADMIN_TOKEN) return undefined
      const owner = credential === null ? undefined : OWNERS[credential]
      const match = /^\/indexes\/([^/]+)\/sync\/(snapshot|feed)$/.exec(ctx.path)
      if (owner === undefined || match === null || decodeURIComponent(match[1] ?? '') !== owner) {
        return { status: 403, code: 'FORBIDDEN', message: 'This credential does not own that index' }
      }
      return state.expiresAt === null ? undefined : { expiresAt: state.expiresAt }
    },
  }
  return state
}

export interface Download {
  status: number
  headers: Headers
  bytes: Uint8Array
}

export async function download(
  base: string,
  index: string,
  token: string,
  headers: Record<string, string> = {},
): Promise<Download> {
  const response = await fetch(`${base}/indexes/${index}/sync/snapshot`, {
    headers: { authorization: `Bearer ${token}`, ...headers },
  })
  return { status: response.status, headers: response.headers, bytes: new Uint8Array(await response.arrayBuffer()) }
}

export async function archivePositions(bytes: Uint8Array): Promise<Position[]> {
  let positions: Position[] = []
  await readSnapshotArchive(createByteReader(bytes), {
    config: async () => undefined,
    manifest: async manifest => {
      positions = manifest.checkpoint.map(entry => ({ partitionId: entry.partitionId, seqNo: entry.lastSeqNo }))
    },
    file: async (_name, _ref, chunks) => {
      for await (const _chunk of chunks) {
      }
    },
  })
  return positions.sort((a, b) => a.partitionId - b.partitionId)
}

export function upgradeStatus(base: string, path: string, protocols: string): Promise<number> {
  const url = new URL(path, base)
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.from('a sixteen-byte k').toString('base64'),
        'sec-websocket-protocol': protocols,
      },
    })
    outgoing.on('upgrade', (response, socket) => {
      socket.destroy()
      resolve(response.statusCode ?? 0)
    })
    outgoing.on('response', response => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

export type FeedMessage = Record<string, unknown> & { type: string }

export interface FeedClient {
  protocol: string
  send(message: unknown): void
  sendRaw(bytes: Uint8Array | string): void
  next(type: string, timeoutMs?: number): Promise<FeedMessage>
  nextAny(timeoutMs?: number): Promise<FeedMessage>
  closed: Promise<{ code: number; reason: string }>
  close(): void
}

export function openFeed(base: string, index: string, token: string): Promise<FeedClient> {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/indexes/${index}/sync/feed`, [SUBPROTOCOL, token])
  socket.binaryType = 'arraybuffer'
  const received: FeedMessage[] = []
  const waiters: Array<() => void> = []
  const closed = new Promise<{ code: number; reason: string }>(resolve => {
    socket.addEventListener('close', event => {
      resolve({ code: event.code, reason: event.reason })
      for (const wake of waiters.splice(0)) wake()
    })
  })
  socket.addEventListener('message', event => {
    received.push(decode(new Uint8Array(event.data as ArrayBuffer)) as FeedMessage)
    for (const wake of waiters.splice(0)) wake()
  })
  const client: FeedClient = {
    get protocol() {
      return socket.protocol
    },
    send: message => socket.send(encode(message)),
    sendRaw: bytes => socket.send(bytes),
    async next(type, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const at = received.findIndex(message => message.type === type)
        if (at >= 0) return received.splice(0, at + 1)[at] as FeedMessage
        if (socket.readyState === WebSocket.CLOSED) throw new Error(`The feed closed before a ${type} message`)
        if (Date.now() > deadline) throw new Error(`No ${type} message within ${timeoutMs} ms`)
        await new Promise<void>(resolve => {
          waiters.push(resolve)
          setTimeout(resolve, 50)
        })
      }
    },
    async nextAny(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const first = received.shift()
        if (first !== undefined) return first
        if (socket.readyState === WebSocket.CLOSED) throw new Error('The feed closed before another message')
        if (Date.now() > deadline) throw new Error(`No feed message within ${timeoutMs} ms`)
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
    socket.addEventListener('open', () => resolve(client))
    socket.addEventListener('error', () => reject(new Error('The feed upgrade failed')))
  })
}
