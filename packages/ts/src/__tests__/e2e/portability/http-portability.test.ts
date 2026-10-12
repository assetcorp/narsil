import { afterEach, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../../client'
import type { TaskRecord } from '../../../server'
import { getJson, postJson, postRaw, startTestServer, type TestServer } from '../../server/helpers'
import { bytesOf, entryNamed, readTar } from './archive-oracle'
import { CATALOG_CONFIG, catalogOf, storedForm } from './harness'

const servers: TestServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

async function serverWithCatalog(limits?: Record<string, number>) {
  const server = await startTestServer(limits === undefined ? undefined : { limits }, { workers: { enabled: false } })
  servers.push(server)
  const documents = catalogOf(80)
  expect((await postJson(server.base, '/indexes', { name: 'catalog', config: CATALOG_CONFIG })).status).toBe(201)
  const batch = await postJson<{ failed: unknown[] }>(server.base, '/indexes/catalog/documents/_batch', {
    action: 'insert',
    documents: [...documents].map(([id, document]) => ({ id, ...document })),
  })
  expect(batch.body.failed).toEqual([])
  return { server, documents }
}

async function finished(base: string, taskId: string): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const polled = await getJson<TaskRecord>(base, `/tasks/${taskId}`)
    if (polled.body.status !== 'running') return polled.body
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('the task never finished')
}

async function storedDocuments(base: string, indexName: string, ids: Iterable<string>) {
  const found = new Map<string, unknown>()
  for (const id of ids) found.set(id, (await getJson(base, `/indexes/${indexName}/documents/${id}`)).body)
  return found
}

describe('snapshots over HTTP', () => {
  it('streams a snapshot archive and restores it as a task into another index', async () => {
    const { server, documents } = await serverWithCatalog()

    const download = await fetch(`${server.base}/indexes/catalog/snapshot`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('application/x-tar')
    const archive = new Uint8Array(await download.arrayBuffer())
    expect(
      readTar(archive)
        .map(entry => entry.name)
        .slice(0, 2),
    ).toEqual(['config', 'manifest'])

    const started = await postRaw<TaskRecord>(server.base, '/indexes/copy/restore', archive, 'application/x-tar')
    expect(started.status).toBe(202)
    const task = await finished(server.base, started.body.id)

    expect(task.status).toBe('succeeded')
    const expected = new Map([...storedForm(documents)].map(([id, document]) => [id, { document }]))
    const stored = await storedDocuments(server.base, 'copy', documents.keys())
    expect(
      new Map([...stored].map(([id, body]) => [id, { document: (body as { document: unknown }).document }])),
    ).toEqual(expected)
  })

  it('refuses an upload above the restore limit with 413 and leaves the index whole', async () => {
    const { server, documents } = await serverWithCatalog({ maxRestoreBytes: 4096 })
    const archive = new Uint8Array(await (await fetch(`${server.base}/indexes/catalog/snapshot`)).arrayBuffer())
    expect(archive.byteLength).toBeGreaterThan(4096)

    const refused = await postRaw<{ error: { code: string } }>(
      server.base,
      '/indexes/catalog/restore',
      archive,
      'application/x-tar',
    )

    expect(refused.status).toBe(413)
    expect(refused.body.error.code).toBe('PAYLOAD_TOO_LARGE')
    expect((await getJson<{ count: number }>(server.base, '/indexes/catalog/count')).body.count).toBe(documents.size)
  })

  it('refuses an empty upload with 400', async () => {
    const { server } = await serverWithCatalog()

    const refused = await postRaw<{ error: { code: string } }>(
      server.base,
      '/indexes/catalog/restore',
      new Uint8Array(0),
      'application/x-tar',
    )

    expect(refused.status).toBe(400)
    expect(refused.body.error.code).toBe('EMPTY_BODY')
  })
})

describe('document exports over HTTP', () => {
  it('streams an export and imports it back as a task that reports what it wrote', async () => {
    const { server, documents } = await serverWithCatalog()

    const download = await fetch(`${server.base}/indexes/catalog/export`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('application/x-ndjson')
    const text = await download.text()
    const lines = text.split('\n').filter(line => line.length > 0)
    expect(JSON.parse(lines[0])).toMatchObject({ format: 'narsil-export', version: 1 })
    expect(lines).toHaveLength(documents.size + 1)

    const started = await postRaw<TaskRecord>(
      server.base,
      '/indexes/copy/import',
      new TextEncoder().encode(`${text}not json\n`),
      'application/x-ndjson',
    )
    expect(started.status).toBe(202)
    expect(started.body.type).toBe('importExport')
    const task = await finished(server.base, started.body.id)

    expect(task.status).toBe('succeeded')
    expect(task.result).toEqual({
      indexed: documents.size,
      failed: 1,
      errors: [{ line: documents.size + 2, code: 'DOC_VALIDATION_FAILED', message: expect.any(String) }],
      errorsTruncated: false,
    })
    expect((await getJson<{ count: number }>(server.base, '/indexes/copy/count')).body.count).toBe(documents.size)
  })

  it('caps the refusals a task reports at the server limit while it counts every one', async () => {
    const { server } = await serverWithCatalog({ maxImportErrors: 2 })
    const header = (await (await fetch(`${server.base}/indexes/catalog/export`)).text()).split('\n')[0]

    const started = await postRaw<TaskRecord>(
      server.base,
      '/indexes/copy/import',
      new TextEncoder().encode(`${header}\nnope\nnope\nnope\nnope\n`),
      'application/x-ndjson',
    )
    const task = await finished(server.base, started.body.id)

    expect(task.result?.failed).toBe(4)
    expect(task.result?.errors).toHaveLength(2)
    expect(task.result?.errorsTruncated).toBe(true)
  })

  it('fails the task with CONFIG_INVALID for an upload without an export header', async () => {
    const { server } = await serverWithCatalog()

    const started = await postRaw<TaskRecord>(
      server.base,
      '/indexes/copy/import',
      new TextEncoder().encode('{"id":"a"}\n'),
      'application/x-ndjson',
    )
    const task = await finished(server.base, started.body.id)

    expect(task.status).toBe('failed')
    expect(task.error?.code).toBe('CONFIG_INVALID')
  })

  it('answers 404 for the export of an index that does not exist, and announces the routes', async () => {
    const { server } = await serverWithCatalog()

    const missing = await fetch(`${server.base}/indexes/nowhere/export`)
    expect(missing.status).toBe(404)
    const capabilities = await getJson<{ capabilities: string[] }>(server.base, '/capabilities')
    expect(capabilities.body.capabilities).toContain('indexes.documentExport')
  })
})

describe('the published client', () => {
  it('downloads and uploads snapshots and document exports as streams', async () => {
    const { server, documents } = await serverWithCatalog()
    const client = createNarsilClient({ url: server.base })

    const archive = await client.snapshot('catalog')
    const restore = await client.restore('from-stream', archive)
    expect((await client.waitForTask(restore.id, { pollIntervalMs: 5 })).status).toBe('succeeded')
    expect(await client.countDocuments('from-stream')).toBe(documents.size)

    const exported = await bytesOf(await client.exportDocuments('catalog'))
    const imported = await client.importDocumentExport('from-export', exported)
    const task = await client.waitForTask(imported.id, { pollIntervalMs: 5 })
    expect(task.status).toBe('succeeded')
    expect(task.result?.indexed).toBe(documents.size)
    expect(await client.get('from-export', 'doc-0003')).toEqual({ id: 'doc-0003', ...documents.get('doc-0003') })

    const reread = readTar(await bytesOf(await client.snapshot('from-export')))
    expect(entryNamed(reread, 'config').data.byteLength).toBeGreaterThan(0)
  })
})
