import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getJson, startTestServer, type TestServer } from './helpers'

const WORKERS_OFF = { workers: { enabled: false } } as const

describe('an engine created with workers switched off', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await startTestServer(undefined, WORKERS_OFF)
  })

  afterEach(async () => {
    await server.stop()
  })

  it('takes every request on the main thread', async () => {
    expect(server.server.requestThreadCount).toBe(0)

    const stats = await server.engine.getMemoryStats()
    expect(stats.workers).toHaveLength(0)
  })
})

describe('the health probes', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await startTestServer(undefined, WORKERS_OFF)
  })

  afterEach(async () => {
    await server.stop()
  })

  it('reports readiness on /health and liveness on /livez', async () => {
    const live = await getJson<{ status: string }>(server.base, '/livez')
    const health = await getJson<{ status: string }>(server.base, '/health')
    const ready = await getJson<{ status: string }>(server.base, '/readyz')

    expect(live.body.status).toBe('ok')
    expect(health.body).toEqual(ready.body)
    expect(health.status).toBe(ready.status)
  })
})
