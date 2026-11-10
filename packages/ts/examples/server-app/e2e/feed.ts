import http from 'node:http'
import type { APIRequestContext, Page } from '@playwright/test'
import { E2E_ORIGIN, E2E_PORT } from './settings'

export const SYNC_SUBPROTOCOL = 'narsil.sync.v1'

export interface Grant {
  credential: string
  expiresAt: number
  indexName: string
  cookie: string
}

export type UpgradeAnswer = { kind: 'refused'; status: number; body: string } | { kind: 'upgraded'; protocol: string }

export interface FeedClose {
  code: number
  openMs: number
}

export async function mintGrant(request: APIRequestContext): Promise<Grant> {
  const opened = await request.post(`${E2E_ORIGIN}/api/notes-space`, {
    headers: { origin: E2E_ORIGIN },
    data: {},
  })
  if (!opened.ok()) throw new Error(`The space route answered ${opened.status()}: ${await opened.text()}`)
  const cookie = opened.headers()['set-cookie'].split(';')[0]
  const response = await request.post(`${E2E_ORIGIN}/api/sync-grant`, {
    headers: { origin: E2E_ORIGIN },
    data: {},
  })
  if (!response.ok()) throw new Error(`The grant route answered ${response.status()}`)
  return { ...(await response.json()), cookie } as Grant
}

export function rawUpgrade(path: string, protocols: string[], cookie = ''): Promise<UpgradeAnswer> {
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
        cookie,
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

export function feedClose(page: Page, indexName: string, credential: string): Promise<FeedClose> {
  return page.evaluate(
    ({ url, token }) =>
      new Promise<{ code: number; openMs: number }>((resolve, reject) => {
        const socket = new WebSocket(url, ['narsil.sync.v1', token])
        let openedAt = 0
        socket.addEventListener('open', () => {
          openedAt = Date.now()
        })
        socket.addEventListener('close', event => resolve({ code: event.code, openMs: Date.now() - openedAt }))
        socket.addEventListener('error', () => reject(new Error('The feed refused the upgrade')))
      }),
    { url: feedUrl(indexName), token: credential },
  )
}
