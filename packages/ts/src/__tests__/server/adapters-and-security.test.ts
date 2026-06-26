import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import { createServer, type TaskRecord, type TaskStore } from '../../server'
import { getJson, postJson, startTestServer, type TestServer } from './helpers'

const VECTOR_SCHEMA = { title: 'string', embedding: 'vector[4]' }

class RecordingTaskStore implements TaskStore {
  readonly records = new Map<string, TaskRecord>()

  async set(record: TaskRecord): Promise<void> {
    this.records.set(record.id, { ...record })
  }

  async get(id: string): Promise<TaskRecord | null> {
    const record = this.records.get(id)
    return record ? { ...record } : null
  }

  async list(): Promise<TaskRecord[]> {
    return [...this.records.values()]
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id)
  }
}

async function pollTask(base: string, id: string, timeoutMs = 4000): Promise<{ status: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await getJson<{ status: string }>(base, `/tasks/${id}`)
    if (res.body.status !== 'running' && res.body.status !== 'queued') return res.body
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('task did not reach a terminal state in time')
}

describe('Narsil HTTP server task store adapter', () => {
  let srv: TestServer
  const store = new RecordingTaskStore()

  beforeEach(async () => {
    store.records.clear()
    srv = await startTestServer({ taskStore: store })
    await postJson(srv.base, '/indexes', { name: 'movies', config: { schema: VECTOR_SCHEMA } })
    await postJson(srv.base, '/indexes/movies/documents/_batch', {
      action: 'insert',
      documents: [
        { id: 'a', title: 'a', embedding: [1, 0, 0, 0] },
        { id: 'b', title: 'b', embedding: [0, 1, 0, 0] },
      ],
    })
  })

  afterEach(async () => {
    await srv.stop()
  })

  it('drives a task through the injected store and reports a terminal status', async () => {
    const accepted = await postJson<{ taskId: string }>(srv.base, '/indexes/movies/vectors/_optimize', {
      field: 'embedding',
    })
    expect(accepted.status).toBe(202)
    expect(store.records.has(accepted.body.taskId)).toBe(true)

    const final = await pollTask(srv.base, accepted.body.taskId)
    expect(final.status).toBe('succeeded')
    expect(store.records.get(accepted.body.taskId)?.status).toBe('succeeded')
    expect(store.records.get(accepted.body.taskId)?.owner).toBeTruthy()
  })

  it('serves task reads from the injected store', async () => {
    const accepted = await postJson<{ taskId: string }>(srv.base, '/indexes/movies/vectors/_optimize', {
      field: 'embedding',
    })
    await pollTask(srv.base, accepted.body.taskId)

    const listed = await getJson<{ tasks: TaskRecord[] }>(srv.base, '/tasks')
    expect(listed.body.tasks.some(t => t.id === accepted.body.taskId)).toBe(true)
  })
})

describe('Narsil HTTP server secure-by-default binding', () => {
  it('refuses a non-loopback bind with no auth hook', async () => {
    const engine = await createNarsil()
    const server = createServer(engine, { host: '0.0.0.0', port: 0 })
    await expect(server.listen()).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await engine.shutdown()
  })

  it('allows a non-loopback bind when allowInsecure is set', async () => {
    const engine = await createNarsil()
    const server = createServer(engine, { host: '0.0.0.0', port: 0, allowInsecure: true })
    await server.listen()
    expect(server.listeningPort).toBeGreaterThan(0)
    await server.close()
    await engine.shutdown()
  })

  it('allows a non-loopback bind when an auth hook is configured', async () => {
    const engine = await createNarsil()
    const server = createServer(engine, { host: '0.0.0.0', port: 0, onRequest: () => undefined })
    await server.listen()
    expect(server.listeningPort).toBeGreaterThan(0)
    await server.close()
    await engine.shutdown()
  })

  it('serves on a loopback bind with no auth', async () => {
    const srv = await startTestServer()
    const res = await getJson<{ status: string }>(srv.base, '/livez')
    expect(res.status).toBe(200)
    await srv.stop()
  })
})
