import { mkdtemp, rm } from 'node:fs/promises'
import { Agent, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openRawChangesFeed, READER_TOKEN } from './changes/fixtures'
import { scaledOut, startTestServer, waitFor } from './helpers'

it.each([false, true])('closes feeds and refuses upgrades during the drain with workers %s', async workers => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-close-feeds-'))
  let admitted: () => void = () => undefined
  let release: () => void = () => undefined
  const started = new Promise<void>(resolve => {
    admitted = resolve
  })
  const released = new Promise<void>(resolve => {
    release = resolve
  })
  const server = await startTestServer(
    {
      changes: true,
      async onRequest(ctx) {
        if (!ctx.path.endsWith('/count')) return
        admitted()
        await released
        return undefined
      },
    },
    { durability: { directory }, workers: { enabled: workers, count: 2 } },
    async engine => {
      await engine.createIndex('articles', { schema: { title: 'string' } })
      await engine.updateChanges('articles', { enabled: true })
      if (!workers) return
      await engine.insertBatch(
        'articles',
        Array.from({ length: 1_000 }, (_, i) => ({ id: String(i), title: 'report' })),
      )
      await waitFor(() => scaledOut(engine, 'articles'))
      await engine.waitForWrites('articles')
    },
  )
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  function get(path: string, headers: Record<string, string> = {}): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
      const pending = request(`${server.base}${path}`, { agent, headers }, response => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
        response.on('error', reject)
      })
      pending.on('error', reject)
      pending.on('upgrade', (_response, socket) => {
        socket.destroy()
        reject(new Error('The closing server admitted a feed'))
      })
      pending.end()
    })
  }
  try {
    const feed = await openRawChangesFeed(server.base, 'articles', READER_TOKEN)
    feed.send({ type: 'subscribe' })
    await feed.next('subscribed')
    expect(await get('/livez')).toBe(200)
    const counting = fetch(`${server.base}/indexes/articles/count`).then(response => response.json())
    await started
    const closing = server.server.close()
    expect((await feed.closed).code).toBe(1001)
    expect(
      await get('/indexes/articles/changes/feed', {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-protocol': 'narsil.changes.v1',
      }),
    ).toBe(503)
    release()
    expect(await counting).toEqual({ count: workers ? 1_000 : 0 })
    await closing
    await server.server.listen()
    const reopened = `http://127.0.0.1:${server.server.listeningPort}`
    const next = await openRawChangesFeed(reopened, 'articles', READER_TOKEN)
    next.send({ type: 'subscribe' })
    await next.next('subscribed')
    next.close()
    await next.closed
  } finally {
    release()
    agent.destroy()
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 40_000)
