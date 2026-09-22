import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IndexConfig } from '../../types/schema'
import { getJson, startTestServer, type TestServer } from './helpers'

const CONFIG: IndexConfig = { schema: { title: 'string' }, language: 'english' }

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

  it('still answers a request', async () => {
    const answer = await getJson<{ indexes: unknown[] }>(server.base, '/indexes')

    expect(answer.status).toBe(200)
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

describe('the capabilities the server announces', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await startTestServer(undefined, WORKERS_OFF, async engine => {
      await engine.createIndex('movies', CONFIG)
    })
  })

  afterEach(async () => {
    await server.stop()
  })

  it('lists the index lifecycle routes', async () => {
    const answer = await getJson<{ capabilities: string[] }>(server.base, '/capabilities')

    expect(answer.body.capabilities).toContain('indexes.lifecycle')
  })
})
