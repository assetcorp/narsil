import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ImportResult, TaskListPage, TaskRecord } from '../../server'
import { getJson, postJson, postRaw, startTestServer, type TestServer, toNdjson } from './helpers'

const SCHEMA = { title: 'string' }

async function createIndex(base: string, name: string): Promise<void> {
  const created = await postJson(base, '/indexes', { name, config: { schema: SCHEMA, language: 'english' } })
  expect(created.status).toBe(201)
}

function documents(count: number, from = 0): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({ id: `doc-${from + index}`, title: `Title ${from + index}` }))
}

async function waitForTerminalStatus(base: string, taskId: string): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const polled = await getJson<TaskRecord>(base, `/tasks/${taskId}`)
    if (polled.body.status !== 'running' && polled.body.status !== 'queued') return polled.body
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('The task never reached a terminal status')
}

describe('task-backed import', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await startTestServer()
    await createIndex(server.base, 'movies')
  })

  afterEach(async () => {
    await server.stop()
  })

  it('answers 202 with the same record shape the poll route returns', async () => {
    const started = await postRaw<TaskRecord>(
      server.base,
      '/indexes/movies/documents/_import?async=true',
      toNdjson(documents(50)),
      'application/x-ndjson',
    )

    expect(started.status).toBe(202)
    expect(started.body.type).toBe('import')
    expect(started.body.indexName).toBe('movies')
    expect(started.body.status).toBe('running')
    expect(typeof started.body.id).toBe('string')
    expect(started.body.progress).toEqual({ indexed: 0, failed: 0, bytesProcessed: 0, bytesTotal: expect.any(Number) })

    const finished = await waitForTerminalStatus(server.base, started.body.id)
    expect(finished.status).toBe('succeeded')
    expect(finished.id).toBe(started.body.id)
    expect(finished.result?.indexed).toBe(50)
    expect(finished.completedAt).toBeGreaterThanOrEqual(finished.createdAt)
    expect(await server.engine.countDocuments('movies')).toBe(50)
  })

  it('reports progress against the body size while the load runs', async () => {
    const started = await postRaw<TaskRecord>(
      server.base,
      '/indexes/movies/documents/_import?async=true',
      toNdjson(documents(4000)),
      'application/x-ndjson',
    )

    const finished = await waitForTerminalStatus(server.base, started.body.id)
    expect(finished.progress?.bytesProcessed).toBe(finished.progress?.bytesTotal)
    expect(finished.progress?.indexed).toBe(4000)
  })

  it('refuses an async import for an index that does not exist', async () => {
    const started = await postRaw<{ error: { code: string } }>(
      server.base,
      '/indexes/missing/documents/_import?async=true',
      toNdjson(documents(1)),
      'application/x-ndjson',
    )

    expect(started.status).toBe(404)
    expect(started.body.error.code).toBe('INDEX_NOT_FOUND')
  })

  it('runs inside the request without the flag', async () => {
    const result = await postRaw<ImportResult>(
      server.base,
      '/indexes/movies/documents/_import',
      toNdjson(documents(5)),
      'application/x-ndjson',
    )

    expect(result.status).toBe(200)
    expect(result.body.indexed).toBe(5)
    expect(result.body.errorsTruncated).toBe(false)
  })
})

describe('import failure reporting', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await startTestServer({ limits: { maxImportErrors: 3 } })
    await createIndex(server.base, 'movies')
  })

  afterEach(async () => {
    await server.stop()
  })

  it('counts every refusal but reports only the first few', async () => {
    const body = Array.from({ length: 10 }, (_, index) => `{"id":"broken-${index}"`).join('\n')

    const result = await postRaw<ImportResult>(
      server.base,
      '/indexes/movies/documents/_import',
      body,
      'application/x-ndjson',
    )

    expect(result.status).toBe(200)
    expect(result.body.indexed).toBe(0)
    expect(result.body.failed).toBe(10)
    expect(result.body.errors).toHaveLength(3)
    expect(result.body.errorsTruncated).toBe(true)
    expect(result.body.errors[0].code).toBe('INVALID_JSON')
  })
})

describe('task cancellation', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await startTestServer()
    await createIndex(server.base, 'movies')
  })

  afterEach(async () => {
    await server.stop()
  })

  it('stops a running import and leaves it cancelled', async () => {
    const started = await postRaw<TaskRecord>(
      server.base,
      '/indexes/movies/documents/_import?async=true',
      toNdjson(documents(20_000)),
      'application/x-ndjson',
    )

    const cancelled = await postJson<TaskRecord>(server.base, `/tasks/${started.body.id}/_cancel`, {})
    expect(cancelled.status).toBe(202)
    expect(typeof cancelled.body.cancelRequestedAt).toBe('number')

    const finished = await waitForTerminalStatus(server.base, started.body.id)
    expect(['cancelled', 'succeeded']).toContain(finished.status)
    if (finished.status === 'cancelled') {
      expect(await server.engine.countDocuments('movies')).toBeLessThan(20_000)
    }
  })

  it('refuses to cancel a task that already finished', async () => {
    const started = await postRaw<TaskRecord>(
      server.base,
      '/indexes/movies/documents/_import?async=true',
      toNdjson(documents(5)),
      'application/x-ndjson',
    )
    await waitForTerminalStatus(server.base, started.body.id)

    const cancelled = await postJson<{ error: { code: string } }>(server.base, `/tasks/${started.body.id}/_cancel`, {})
    expect(cancelled.status).toBe(409)
    expect(cancelled.body.error.code).toBe('TASK_NOT_CANCELLABLE')
  })

  it('answers 404 for a task nobody started', async () => {
    const cancelled = await postJson<{ error: { code: string } }>(server.base, '/tasks/missing-task/_cancel', {})
    expect(cancelled.status).toBe(404)
    expect(cancelled.body.error.code).toBe('TASK_NOT_FOUND')
  })
})

describe('task listing', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await startTestServer()
    await createIndex(server.base, 'movies')
    await createIndex(server.base, 'books')
    for (const indexName of ['movies', 'books', 'movies']) {
      const started = await postRaw<TaskRecord>(
        server.base,
        `/indexes/${indexName}/documents/_import?async=true`,
        toNdjson(documents(3)),
        'application/x-ndjson',
      )
      await waitForTerminalStatus(server.base, started.body.id)
    }
  })

  afterEach(async () => {
    await server.stop()
  })

  it('returns every task newest first by default', async () => {
    const page = await getJson<TaskListPage>(server.base, '/tasks')

    expect(page.body.total).toBe(3)
    expect(page.body.tasks).toHaveLength(3)
    expect(page.body.next).toBeNull()
    const timestamps = page.body.tasks.map(task => task.createdAt)
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps)
  })

  it('keeps only the tasks an index owns', async () => {
    const page = await getJson<TaskListPage>(server.base, '/tasks?indexName=books')

    expect(page.body.total).toBe(1)
    expect(page.body.tasks[0].indexName).toBe('books')
  })

  it('keeps only the requested statuses and types', async () => {
    const succeeded = await getJson<TaskListPage>(server.base, '/tasks?status=succeeded&type=import')
    expect(succeeded.body.total).toBe(3)

    const running = await getJson<TaskListPage>(server.base, '/tasks?status=running')
    expect(running.body.total).toBe(0)
  })

  it('pages through the matches and reports where the next page starts', async () => {
    const first = await getJson<TaskListPage>(server.base, '/tasks?limit=2')
    expect(first.body.tasks).toHaveLength(2)
    expect(first.body.next).toBe(2)

    const second = await getJson<TaskListPage>(server.base, `/tasks?limit=2&from=${first.body.next}`)
    expect(second.body.tasks).toHaveLength(1)
    expect(second.body.next).toBeNull()
    expect(second.body.tasks[0].id).not.toBe(first.body.tasks[0].id)
  })

  it('refuses an unknown status, an unknown type, and an oversized page', async () => {
    const badStatus = await getJson<{ error: { code: string } }>(server.base, '/tasks?status=sleeping')
    expect(badStatus.status).toBe(400)
    expect(badStatus.body.error.code).toBe('INVALID_REQUEST')

    const badType = await getJson(server.base, '/tasks?type=reticulating')
    expect(badType.status).toBe(400)

    const badLimit = await getJson(server.base, '/tasks?limit=0')
    expect(badLimit.status).toBe(400)

    const overSized = await getJson(server.base, '/tasks?limit=1001')
    expect(overSized.status).toBe(400)
  })
})

describe('capabilities', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await startTestServer()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('announces every optional route the client can use', async () => {
    const announced = await getJson<{ capabilities: string[] }>(server.base, '/capabilities')

    expect(announced.status).toBe(200)
    expect(announced.body.capabilities).toEqual(
      expect.arrayContaining(['documents.import.async', 'tasks.cancel', 'tasks.filter', 'indexes.rebuildAnalysis']),
    )
  })

  it('needs no API key, matching the health probes', async () => {
    const guarded = await startTestServer({ onRequest: () => ({ status: 401, code: 'UNAUTHORIZED', message: 'no' }) })
    try {
      const announced = await getJson(guarded.base, '/capabilities')
      expect(announced.status).toBe(200)
    } finally {
      await guarded.stop()
    }
  })
})

describe('analysis rebuild route', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await startTestServer()
    await createIndex(server.base, 'movies')
  })

  afterEach(async () => {
    await server.stop()
  })

  it('starts a task against an index that exists', async () => {
    const started = await postJson<TaskRecord>(server.base, '/indexes/movies/_rebuild-analysis', {})

    expect(started.status).toBe(202)
    expect(started.body.type).toBe('rebuildAnalysis')
    const finished = await waitForTerminalStatus(server.base, started.body.id)
    expect(finished.status).toBe('succeeded')
  })

  it('answers 404 for an index that does not exist', async () => {
    const started = await postJson<{ error: { code: string } }>(server.base, '/indexes/missing/_rebuild-analysis', {})

    expect(started.status).toBe(404)
    expect(started.body.error.code).toBe('INDEX_NOT_FOUND')
  })
})
