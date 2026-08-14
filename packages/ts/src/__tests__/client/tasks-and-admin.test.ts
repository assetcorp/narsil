import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ASYNC_IMPORT_CAPABILITY,
  createNarsilClient,
  type NarsilClient,
  REBUILD_ANALYSIS_CAPABILITY,
  type TaskRecord,
} from '../../client'
import { NarsilError } from '../../errors'
import { startTestServer, type TestServer } from '../server/helpers'

const SCHEMA = { title: 'string' }

function movies(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({ id: `m${index}`, title: `Movie ${index}` }))
}

describe('client task and maintenance routes', () => {
  let server: TestServer
  let client: NarsilClient

  beforeEach(async () => {
    server = await startTestServer()
    client = createNarsilClient({ url: server.base })
    await client.createIndex('movies', { schema: SCHEMA, language: 'english' })
  })

  afterEach(async () => {
    await server.stop()
  })

  it('loads a corpus in one request and reports what it refused', async () => {
    const ndjson = `${movies(3)
      .map(document => JSON.stringify(document))
      .join('\n')}\nnot json\n{"id":"m9","title":42}`
    const result = await client.importDocuments('movies', ndjson)
    expect(result.indexed).toBe(3)
    expect(result.failed).toBe(2)
    expect(result.errors.map(entry => entry.code)).toEqual(['INVALID_JSON', 'DOC_VALIDATION_FAILED'])
    expect(result.errorsTruncated).toBe(false)
    expect(await client.countDocuments('movies')).toBe(3)
  })

  it('accepts a corpus that is already NDJSON', async () => {
    const ndjson = movies(2)
      .map(document => JSON.stringify(document))
      .join('\n')
    expect((await client.importDocuments('movies', ndjson)).indexed).toBe(2)
  })

  it('follows an asynchronous import to its finished record', async () => {
    const started = await client.startImport('movies', movies(200))
    expect(started.type).toBe('import')
    expect(started.status).toBe('running')

    const seen: TaskRecord[] = []
    const finished = await client.waitForTask(started.id, {
      pollIntervalMs: 5,
      onProgress: record => seen.push(record),
    })

    expect(finished.status).toBe('succeeded')
    expect(finished.result?.indexed).toBe(200)
    expect(seen.at(-1)?.status).toBe('succeeded')
    expect(await client.countDocuments('movies')).toBe(200)
  })

  it('reads a task back and reports an unknown one as null', async () => {
    const started = await client.startImport('movies', movies(5))
    expect((await client.getTask(started.id))?.id).toBe(started.id)
    expect(await client.getTask('no-such-task')).toBeNull()
    await client.waitForTask(started.id, { pollIntervalMs: 5 })
  })

  it('lists tasks filtered by index, type, and status', async () => {
    const started = await client.startImport('movies', movies(5))
    await client.waitForTask(started.id, { pollIntervalMs: 5 })

    const page = await client.listTasks({ indexName: 'movies', type: ['import'], status: ['succeeded'] })
    expect(page.total).toBe(1)
    expect(page.tasks[0].id).toBe(started.id)
    expect(page.next).toBeNull()

    expect((await client.listTasks({ type: ['rebalance'] })).total).toBe(0)
  })

  it('refuses to cancel a task that has already finished', async () => {
    const started = await client.startImport('movies', movies(5))
    await client.waitForTask(started.id, { pollIntervalMs: 5 })

    const failure = await client.cancelTask(started.id).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(NarsilError)
    expect((failure as NarsilError).code).toBe('TASK_NOT_CANCELLABLE')
    expect((failure as NarsilError).details.status).toBe(409)
  })

  it('takes a snapshot and restores it as a task', async () => {
    await client.insertBatch('movies', movies(4))
    const bytes = await client.snapshot('movies')
    expect(bytes.byteLength).toBeGreaterThan(0)

    await client.clear('movies')
    const restore = await client.waitForTask((await client.restore('movies', bytes)).id, { pollIntervalMs: 5 })
    expect(restore.status).toBe('succeeded')
    expect(restore.type).toBe('restore')
    expect(await client.countDocuments('movies')).toBe(4)
  })

  it('reports a corrupt snapshot on the task that tried to read it', async () => {
    const record = await client.waitForTask((await client.restore('movies', new Uint8Array([1, 2, 3]))).id, {
      pollIntervalMs: 5,
    })
    expect(record.status).toBe('failed')
    expect(record.error?.code).toBe('DOC_VALIDATION_FAILED')
  })

  it('checkpoints, reports vector maintenance, and reshapes partitions', async () => {
    await client.insertBatch('movies', movies(4))
    await client.checkpoint('movies')
    expect(await client.vectorMaintenanceStatus('movies')).toEqual([])
    await client.compactVectors('movies')
    expect((await client.waitForTask((await client.optimizeVectors('movies')).id, { pollIntervalMs: 5 })).status).toBe(
      'succeeded',
    )

    await client.updatePartitionConfig('movies', { maxDocsPerPartition: 1000 })
    const rebalanced = await client.waitForTask((await client.rebalance('movies', 2)).id, { pollIntervalMs: 5 })
    expect(rebalanced.status).toBe('succeeded')
    expect((await client.getStats('movies')).partitionCount).toBe(2)
  })

  it('rebuilds analysis as a task', async () => {
    const record = await client.waitForTask((await client.rebuildAnalysis('movies')).id, { pollIntervalMs: 5 })
    expect(record.status).toBe('succeeded')
    expect(record.type).toBe('rebuildAnalysis')
  })

  it('reports the build, the capabilities, and the probes', async () => {
    expect((await client.version()).name).toBe('narsil')
    expect(await client.isAlive()).toBe(true)
    expect(await client.isReady()).toBe(true)

    expect(await client.supports(ASYNC_IMPORT_CAPABILITY)).toBe(true)
    expect(await client.supports(REBUILD_ANALYSIS_CAPABILITY)).toBe(true)
    expect(await client.supports('something.else')).toBe(false)
    expect(await client.capabilities()).toContain(ASYNC_IMPORT_CAPABILITY)
  })

  it('reports the memory figures the server holds', async () => {
    const stats = await client.getMemoryStats()
    expect(stats.estimatedIndexBytes).toBeGreaterThanOrEqual(0)
    expect(stats.workers).toEqual([])
  })
})
