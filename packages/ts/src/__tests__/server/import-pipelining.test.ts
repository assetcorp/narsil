import { afterEach, describe, expect, it } from 'vitest'
import type { Narsil } from '../../narsil'
import { runImport } from '../../server/handlers/import'
import { getJson, postJson, postRaw, startTestServer, type TestServer, toNdjson } from './helpers'

interface ImportBody {
  indexed: number
  failed: number
  errors: Array<{ docId?: string; line?: number; code: string }>
}

describe('cancelling a pipelined NDJSON import', () => {
  it('rejects only after every batch already writing has settled, reporting what those batches indexed', async () => {
    let writing = 0
    let written = 0
    const engine = {
      async insertBatch(_indexName: string, documents: Array<{ id: string }>) {
        writing += 1
        await new Promise(resolve => setTimeout(resolve, 30))
        writing -= 1
        written += documents.length
        return { succeeded: documents.map(document => document.id), failed: [] }
      },
    } as unknown as Narsil
    const controller = new AbortController()
    const reported: number[] = []
    const lines = Array.from({ length: 40 }, (_, index) => ({ id: `d${index}`, title: `note ${index}` }))

    const run = runImport(engine, {
      indexName: 'notes',
      body: Buffer.from(toNdjson(lines)),
      maxLineBytes: 1_048_576,
      batchSize: 4,
      maxErrors: 10,
      signal: controller.signal,
      onProgress: progress => reported.push(progress.indexed),
    })
    setTimeout(() => controller.abort(), 5)

    await expect(run).rejects.toThrow()
    expect(writing).toBe(0)
    expect(written).toBeGreaterThan(0)
    expect(written).toBeLessThan(lines.length)
    expect(reported.at(-1)).toBe(written)
  })
})

describe('pipelined NDJSON import', () => {
  let srv: TestServer

  afterEach(async () => {
    await srv.stop()
  })

  it('gives a repeated id the outcome it would meet one batch at a time', async () => {
    srv = await startTestServer({ limits: { importBatchSize: 3 } }, { workers: { enabled: false } })
    await postJson(srv.base, '/indexes', { name: 'notes', config: { schema: { title: 'string' } } })

    const lines = []
    lines.push({ id: 'x', title: 5 })
    for (let index = 1; index <= 10; index++) lines.push({ id: `d${index}`, title: `first ${index}` })
    lines.push({ id: 'd2', title: 'second 2' })
    lines.push({ id: 'x', title: 'valid at last' })
    lines.push({ id: 'd2', title: 'third 2' })

    const result = await postRaw<ImportBody>(
      srv.base,
      '/indexes/notes/documents/_import',
      toNdjson(lines),
      'application/x-ndjson',
    )
    expect(result.status).toBe(200)
    expect(result.body.indexed).toBe(11)
    expect(result.body.failed).toBe(3)
    expect(result.body.errors.filter(error => error.docId === 'd2').map(error => error.code)).toEqual([
      'DOC_ALREADY_EXISTS',
      'DOC_ALREADY_EXISTS',
    ])

    const stored = await getJson<{ document: { title: string } }>(srv.base, '/indexes/notes/documents/d2')
    expect(stored.body.document.title).toBe('first 2')
    const late = await getJson<{ document: { title: string } }>(srv.base, '/indexes/notes/documents/x')
    expect(late.body.document.title).toBe('valid at last')
  })

  it('indexes every document while several batches build on separate workers', async () => {
    srv = await startTestServer({ limits: { importBatchSize: 200 } }, { workers: { enabled: true, count: 2 } })
    await postJson(srv.base, '/indexes', { name: 'notes', config: { schema: { title: 'string' } } })

    const lines = []
    for (let index = 0; index < 2500; index++)
      lines.push({ id: `d${index}`, title: `note number ${index} about topic${index % 17}` })

    const result = await postRaw<ImportBody>(
      srv.base,
      '/indexes/notes/documents/_import',
      toNdjson(lines),
      'application/x-ndjson',
    )
    expect(result.status).toBe(200)
    expect(result.body.indexed).toBe(2500)
    expect(result.body.failed).toBe(0)

    const count = await getJson<{ count: number }>(srv.base, '/indexes/notes/count')
    expect(count.body.count).toBe(2500)
    const found = await postJson<{ count: number }>(srv.base, '/indexes/notes/search', { term: 'topic3', limit: 5 })
    expect(found.body.count).toBe(Math.floor((2500 - 1 - 3) / 17) + 1)
  })
})
