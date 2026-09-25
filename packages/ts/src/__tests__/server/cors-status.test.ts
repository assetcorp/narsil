import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RequestContext } from '../../server'
import { startTestServer, type TestServer } from './helpers'

const ORIGIN = 'https://shop.example'

describe('Narsil HTTP server with CORS', () => {
  let srv: TestServer
  const seenMethods: string[] = []

  beforeEach(async () => {
    seenMethods.length = 0
    srv = await startTestServer({
      cors: { origin: [ORIGIN] },
      onRequest: (context: RequestContext) => {
        seenMethods.push(context.method)
        if (context.path === '/indexes/locked') {
          return { status: 403, code: 'ACCESS_DENIED', message: 'This index belongs to another tenant' }
        }
        return undefined
      },
    })
  })

  afterEach(async () => {
    await srv.stop()
  })

  it('keeps the status of a hook denial and adds the allowed origin after it', async () => {
    const res = await fetch(`${srv.base}/indexes/locked`, { method: 'DELETE', headers: { Origin: ORIGIN } })

    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(res.headers.get('vary')).toBe('Origin')
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ACCESS_DENIED')
  })

  it('keeps the status of an engine error and of an unknown route', async () => {
    const missing = await fetch(`${srv.base}/indexes/nowhere/stats`, { headers: { Origin: ORIGIN } })
    expect(missing.status).toBe(404)
    expect(missing.headers.get('access-control-allow-origin')).toBe(ORIGIN)

    const unrouted = await fetch(`${srv.base}/no-such-route`, { headers: { Origin: ORIGIN } })
    expect(unrouted.status).toBe(404)
    expect(unrouted.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })

  it('hands the hook the method in upper case', async () => {
    await fetch(`${srv.base}/indexes/locked`, { method: 'DELETE', headers: { Origin: ORIGIN } })

    expect(seenMethods).toContain('DELETE')
  })
})
