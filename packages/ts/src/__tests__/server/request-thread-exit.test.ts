import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SHUTDOWN_TIMEOUT_MS } from '../../workers/constants'
import { getJson, startTestServer } from './helpers'

const distEntry = new URL('../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

describe.skipIf(!built)('a request thread that the engine asks to leave', () => {
  it('closes its listener and exits by itself, so the engine stops without waiting out the shutdown timeout', async () => {
    const srv = await startTestServer(undefined, { workers: { count: 2 } })
    const alive = await getJson(srv.base, '/livez')
    expect(alive.status).toBe(200)
    expect(srv.server.requestThreadCount).toBe(2)

    const startedAt = performance.now()
    await srv.stop()
    const stoppedAfterMs = performance.now() - startedAt

    expect(stoppedAfterMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS)
    await expect(fetch(`${srv.base}/livez`)).rejects.toThrow()
  })

  it('stops the socket and the engine behind it from one call', async () => {
    const srv = await startTestServer(undefined, { workers: { count: 2 } })
    expect((await getJson(srv.base, '/livez')).status).toBe(200)

    await srv.server.shutdown()

    await expect(fetch(`${srv.base}/livez`)).rejects.toThrow()
    await expect(srv.engine.countDocuments('movies')).rejects.toThrow('This Narsil instance has been shut down')
  })
})
