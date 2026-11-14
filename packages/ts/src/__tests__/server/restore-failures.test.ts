import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TaskRecord } from '../../server'
import { getJson, postJson, postRaw, startTestServer, type TestServer } from './helpers'

async function waitForTerminalStatus(base: string, taskId: string): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const polled = await getJson<TaskRecord>(base, `/tasks/${taskId}`)
    if (polled.body.status !== 'running') return polled.body
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('The task never reached a terminal status')
}

async function restoreBytes(base: string, bytes: Uint8Array): Promise<TaskRecord> {
  const started = await postRaw<TaskRecord>(base, '/indexes/movies/restore', bytes, 'application/octet-stream')
  expect(started.status).toBe(202)
  return waitForTerminalStatus(base, started.body.id)
}

describe('restore with a body that is not a snapshot', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await startTestServer()
    await postJson(server.base, '/indexes', { name: 'movies', config: { schema: { title: 'string' } } })
  })

  afterEach(async () => {
    await server.stop()
  })

  it('names the failure of an old-format snapshot cut inside its header', async () => {
    const finished = await restoreBytes(server.base, new Uint8Array([0x4e, 0x52, 0x53, 0x4c, 3, 0, 0]))

    expect(finished.status).toBe('failed')
    expect(finished.error?.code).toBe('ENVELOPE_INVALID_MAGIC')
    expect(finished.error?.message).toContain('32 bytes')
  })

  it('rejects a body that holds no snapshot archive', async () => {
    const finished = await restoreBytes(server.base, new Uint8Array(40).fill(0xc0))

    expect(finished.status).toBe('failed')
    expect(finished.error?.code).toBe('PERSISTENCE_LOAD_FAILED')
  })
})
