import type { IncomingMessage } from 'node:http'
import http from 'node:http'
import https from 'node:https'
import type { Duplex } from 'node:stream'
import type { Plugin } from 'vite'
import { demoServerPromise } from './src/lib/demo-server-state.ts'
import { readServerConfig } from './src/lib/server-config.ts'
import { offeredFeedCredential, SYNC_SUBPROTOCOL } from './src/lib/sync-grant.ts'

const PROXY_PREFIX = '/api/narsil/'
const SYNC_FEED_PATH = /^\/api\/narsil\/indexes\/([^/]+)\/sync\/feed$/
const FEED_CREDENTIAL = /^[A-Za-z0-9._~-]{1,1024}$/
const FORWARDED_UPGRADE_HEADERS = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions']
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000
const MAX_REFUSAL_BODY_BYTES = 64 * 1024
const RELAYED_REFUSAL_HEADERS = ['content-type', 'retry-after']

function refuse(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return
  const body = JSON.stringify({ error: { code: 'INVALID_REQUEST', message: reason } })
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\n` +
      'content-type: application/json\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      'connection: close\r\n\r\n' +
      body,
  )
}

function relayRefusal(response: IncomingMessage, client: Duplex): void {
  const chunks: Buffer[] = []
  let length = 0
  response.on('data', (chunk: Buffer) => {
    if (length >= MAX_REFUSAL_BODY_BYTES) return
    const kept = chunk.subarray(0, MAX_REFUSAL_BODY_BYTES - length)
    chunks.push(kept)
    length += kept.length
  })
  response.on('error', () => client.destroy())
  response.on('end', () => {
    if (client.destroyed) return
    const status = response.statusCode ?? 502
    const body = Buffer.concat(chunks)
    let head = `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\n`
    for (const name of RELAYED_REFUSAL_HEADERS) {
      const value = response.headers[name]
      if (typeof value === 'string') head += `${name}: ${value}\r\n`
    }
    head += `content-length: ${body.length}\r\nconnection: close\r\n\r\n`
    client.end(Buffer.concat([Buffer.from(head), body]))
  })
}

function rawHeadersOf(message: IncomingMessage): string {
  let text = ''
  for (let i = 0; i + 1 < message.rawHeaders.length; i += 2) {
    text += `${message.rawHeaders[i]}: ${message.rawHeaders[i + 1]}\r\n`
  }
  return text
}

function syncSubprotocols(header: string | undefined): string | null {
  const offered = offeredFeedCredential(header)
  if (offered === null) return null
  const { credential } = offered
  if (credential === undefined) return SYNC_SUBPROTOCOL
  return FEED_CREDENTIAL.test(credential) ? `${SYNC_SUBPROTOCOL}, ${credential}` : null
}

function pipeSockets(client: Duplex, upstream: Duplex): void {
  const closeBoth = (): void => {
    client.destroy()
    upstream.destroy()
  }
  client.on('error', closeBoth)
  upstream.on('error', closeBoth)
  client.on('close', () => upstream.destroy())
  upstream.on('close', () => client.destroy())
  client.pipe(upstream)
  upstream.pipe(client)
}

async function forwardFeed(
  request: IncomingMessage,
  client: Duplex,
  head: Buffer,
  indexSegment: string,
  subprotocols: string,
): Promise<void> {
  const starting = demoServerPromise()
  if (starting) await starting

  const config = readServerConfig()
  const target = new URL(config.baseUrl)
  const basePath = target.pathname.replace(/\/+$/, '')
  const headers: Record<string, string> = {
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-protocol': subprotocols,
  }
  if (config.apiKey !== undefined) headers.authorization = `Bearer ${config.apiKey}`
  for (const name of FORWARDED_UPGRADE_HEADERS) {
    const value = request.headers[name]
    if (typeof value === 'string') headers[name] = value
  }

  const transport = target.protocol === 'https:' ? https : http
  const upstreamRequest = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: 'GET',
    path: `${basePath}/indexes/${indexSegment}/sync/feed`,
    headers,
    timeout: UPSTREAM_CONNECT_TIMEOUT_MS,
  })

  client.on('error', () => upstreamRequest.destroy())

  upstreamRequest.on('timeout', () => {
    upstreamRequest.destroy()
    refuse(client, 504, 'The search server did not answer the upgrade in time')
  })

  upstreamRequest.on('error', () => {
    refuse(client, 502, 'The search server did not answer the upgrade')
  })

  upstreamRequest.on('response', response => {
    relayRefusal(response, client)
  })

  upstreamRequest.on('upgrade', (response, upstream, upstreamHead) => {
    upstreamRequest.setTimeout(0)
    if (client.destroyed) {
      upstream.destroy()
      return
    }
    client.write(`HTTP/1.1 101 Switching Protocols\r\n${rawHeadersOf(response)}\r\n`)
    if (upstreamHead.length > 0) client.write(upstreamHead)
    if (head.length > 0) upstream.write(head)
    pipeSockets(client, upstream)
  })

  upstreamRequest.end()
}

function handleUpgrade(request: IncomingMessage, client: Duplex, head: Buffer): void {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith(PROXY_PREFIX)) return

  const match = SYNC_FEED_PATH.exec(url.pathname)
  const indexSegment = match?.[1]
  if (indexSegment === undefined || url.search.length > 0) {
    refuse(client, 404, 'Only the device sync feed accepts a WebSocket here')
    return
  }
  const subprotocols = syncSubprotocols(request.headers['sec-websocket-protocol'])
  if (subprotocols === null) {
    refuse(client, 400, `The upgrade must offer the subprotocol ${SYNC_SUBPROTOCOL} and at most one credential`)
    return
  }

  forwardFeed(request, client, head, indexSegment, subprotocols).catch((err: unknown) => {
    refuse(client, 503, err instanceof Error ? err.message : String(err))
  })
}

export function syncFeedProxyPlugin(): Plugin {
  return {
    name: 'narsil-sync-feed-proxy',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.on('upgrade', handleUpgrade)
    },
  }
}
