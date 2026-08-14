import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TaskRecord } from '../../server'
import { getJson, postJson, postRaw, startTestServer, type TestServer } from './helpers'

async function waitForTerminalStatus(base: string, taskId: string): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const polled = await getJson<TaskRecord>(base, `/tasks/${taskId}`)
    if (polled.body.status !== 'running' && polled.body.status !== 'queued') return polled.body
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

  it('names the failure rather than reporting an internal error', async () => {
    const finished = await restoreBytes(server.base, new Uint8Array([1, 2, 3, 4]))

    expect(finished.status).toBe('failed')
    expect(finished.error?.code).toBe('DOC_VALIDATION_FAILED')
    expect(finished.error?.message).toContain('not a Narsil snapshot')
  })

  it('rejects a body that decodes to something other than an envelope', async () => {
    const finished = await restoreBytes(server.base, new Uint8Array([0xc0]))

    expect(finished.status).toBe('failed')
    expect(finished.error?.code).toBe('DOC_VALIDATION_FAILED')
    expect(finished.error?.message).toContain('envelope')
  })

  it('round-trips a snapshot the engine produced', async () => {
    await postJson(server.base, '/indexes/movies/documents', { document: { title: 'Dune' } })
    const bytes = await server.engine.snapshot('movies')
    await postJson(server.base, '/indexes', { name: 'copy', config: { schema: { title: 'string' } } })

    const started = await postRaw<TaskRecord>(server.base, '/indexes/copy/restore', bytes, 'application/octet-stream')
    const finished = await waitForTerminalStatus(server.base, started.body.id)

    expect(finished.status).toBe('succeeded')
    expect(await server.engine.countDocuments('copy')).toBe(1)
  })
})
