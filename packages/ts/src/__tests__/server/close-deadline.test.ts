import { request } from 'node:http'
import { it } from 'vitest'
import { scaledOut, startTestServer, waitFor } from './helpers'

it.concurrent.for([false, true])(
  'drops a stalled request after the drain deadline with workers %s',
  { timeout: 40_000 },
  async (workers, { expect }) => {
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
        async onRequest() {
          admitted()
          await released
          return undefined
        },
      },
      { workers: { enabled: workers, count: 2 } },
      async engine => {
        await engine.createIndex('articles', { schema: { title: 'string' } })
        if (!workers) return
        await engine.insertBatch(
          'articles',
          Array.from({ length: 1_000 }, (_, i) => ({ id: String(i), title: 'report' })),
        )
        await waitFor(() => scaledOut(engine, 'articles'))
        await engine.waitForWrites('articles')
      },
    )
    const pending = request(`${server.base}/indexes/articles/count`)
    const ended = new Promise<'closed' | number | undefined>(resolve => {
      pending.on('error', () => resolve('closed'))
      pending.on('response', response => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      })
    })
    try {
      pending.end()
      await started
      const began = performance.now()
      let closed = false
      const closing = server.server.close().then(() => {
        closed = true
      })
      await new Promise(resolve => setTimeout(resolve, 29_000))
      expect(closed).toBe(false)
      await closing
      const elapsed = performance.now() - began
      expect(elapsed).toBeGreaterThanOrEqual(30_000)
      expect(elapsed).toBeLessThan(35_000)
      expect(['closed', 503]).toContain(await ended)
      expect(server.server.listeningPort).toBe(-1)
    } finally {
      release()
      pending.destroy()
      await server.stop()
    }
  },
)
