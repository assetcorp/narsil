import http from 'node:http'
import { E2E_ORIGIN, E2E_PORT } from './settings'

export const SYNC_SUBPROTOCOL = 'narsil.sync.v1'

export interface Grant {
  credential: string
  expiresAt: number
}

export type UpgradeAnswer = { kind: 'refused'; status: number; body: string } | { kind: 'upgraded'; protocol: string }

export interface FeedClose {
  code: number
  openMs: number
}

export async function mintGrant(indexName: string): Promise<Grant> {
  const response = await fetch(`${E2E_ORIGIN}/api/sync-grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ indexName }),
  })
  if (response.status !== 200) throw new Error(`The grant route answered ${response.status}`)
  return (await response.json()) as Grant
}

export function rawUpgrade(path: string, protocols: string[]): Promise<UpgradeAnswer> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: 'localhost',
      port: E2E_PORT,
      path,
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.from('narsil-e2e-key-1').toString('base64'),
        'sec-websocket-protocol': protocols.join(', '),
      },
    })
    request.on('response', response => {
      let body = ''
      response.setEncoding('utf-8')
      response.on('data', chunk => {
        body += chunk
      })
      response.on('end', () => resolve({ kind: 'refused', status: response.statusCode ?? 0, body }))
    })
    request.on('upgrade', (response, socket) => {
      socket.destroy()
      resolve({ kind: 'upgraded', protocol: String(response.headers['sec-websocket-protocol'] ?? '') })
    })
    request.on('error', reject)
    request.end()
  })
}

export function feedUrl(indexName: string): string {
  return `ws://localhost:${E2E_PORT}/api/narsil/indexes/${encodeURIComponent(indexName)}/sync/feed`
}

export function openFeed(indexName: string, credential: string): Promise<{ closed: Promise<FeedClose> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(feedUrl(indexName), [SYNC_SUBPROTOCOL, credential])
    let openedAt = 0
    const closed = new Promise<FeedClose>(resolveClose => {
      socket.addEventListener('close', event => {
        resolveClose({ code: event.code, openMs: openedAt === 0 ? 0 : Date.now() - openedAt })
      })
    })
    socket.addEventListener('open', () => {
      openedAt = Date.now()
      resolve({ closed })
    })
    socket.addEventListener('error', () => {
      if (openedAt === 0) reject(new Error('The feed refused the upgrade'))
    })
  })
}
