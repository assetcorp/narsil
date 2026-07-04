import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getJson, postJson, postRaw, startTestServer, type TestServer, toNdjson } from './helpers'

const SCHEMA = { docId: 'string', text: 'string' }

const TEXT_CHARS_PER_DOC = 12_000

const BATCH_DOC_COUNT = 600
const IMPORT_DOC_COUNT = 1500

interface Corpus {
  documents: Array<{ id: string; docId: string; text: string }>
  byId: Map<string, string>
}

/** Builds per-document text whose every segment is keyed to that document's own
 * id, so a cross-chunk byte overwrite (the request-body corruption this test
 * guards against) changes a value the equality assertions read instead of
 * passing on coincidentally identical bytes. */
function buildText(id: string, charTarget: number): string {
  const segments: string[] = []
  let length = 0
  let position = 0
  while (length < charTarget) {
    const segment = `${id}:seg${position}:${id.split('').reverse().join('')};`
    segments.push(segment)
    length += segment.length
    position++
  }
  return segments.join('').slice(0, charTarget)
}

function buildCorpus(count: number, charTarget: number): Corpus {
  const documents: Array<{ id: string; docId: string; text: string }> = []
  const byId = new Map<string, string>()
  for (let i = 0; i < count; i++) {
    const id = `doc-${i.toString().padStart(6, '0')}`
    const text = buildText(id, charTarget)
    documents.push({ id, docId: id, text })
    byId.set(id, text)
  }
  return { documents, byId }
}

function samplePositions(count: number): number[] {
  return [0, Math.floor(count / 2), count - 1]
}

async function createIndex(base: string): Promise<void> {
  const created = await postJson(base, '/indexes', { name: 'articles', config: { schema: SCHEMA } })
  expect(created.status).toBe(201)
}

async function assertRoundTrip(base: string, corpus: Corpus, count: number): Promise<void> {
  for (const position of samplePositions(count)) {
    const id = `doc-${position.toString().padStart(6, '0')}`
    const expected = corpus.byId.get(id)
    expect(expected).toBeDefined()
    const fetched = await getJson<{ document: { docId: string; text: string } }>(
      base,
      `/indexes/articles/documents/${id}`,
    )
    expect(fetched.status).toBe(200)
    expect(fetched.body.document.docId).toBe(id)
    expect(fetched.body.document.text).toBe(expected)
  }
}

describe('large request bodies survive HTTP ingest intact', () => {
  let srv: TestServer

  beforeEach(async () => {
    srv = await startTestServer()
    await createIndex(srv.base)
  })

  afterEach(async () => {
    await srv.stop()
  })

  it('indexes every document from a multi-megabyte JSON batch with bodies preserved byte-for-byte', async () => {
    const corpus = buildCorpus(BATCH_DOC_COUNT, TEXT_CHARS_PER_DOC)

    const batch = await postJson<{ succeeded: string[]; failed: Array<{ docId: string }> }>(
      srv.base,
      '/indexes/articles/documents/_batch',
      { action: 'insert', documents: corpus.documents },
    )
    expect(batch.status).toBe(200)
    expect(batch.body.failed).toHaveLength(0)
    expect(batch.body.succeeded).toHaveLength(BATCH_DOC_COUNT)

    const count = await getJson<{ count: number }>(srv.base, '/indexes/articles/count')
    expect(count.body.count).toBe(BATCH_DOC_COUNT)

    await assertRoundTrip(srv.base, corpus, BATCH_DOC_COUNT)
  }, 30_000)

  it('indexes every document from a multi-megabyte NDJSON import with bodies preserved byte-for-byte', async () => {
    const corpus = buildCorpus(IMPORT_DOC_COUNT, TEXT_CHARS_PER_DOC)

    const ndjson = toNdjson(corpus.documents)
    const result = await postRaw<{ indexed: number; failed: number; errors: unknown[] }>(
      srv.base,
      '/indexes/articles/documents/_import',
      ndjson,
      'application/x-ndjson',
    )
    expect(result.status).toBe(200)
    expect(result.body.failed).toBe(0)
    expect(result.body.indexed).toBe(IMPORT_DOC_COUNT)

    const count = await getJson<{ count: number }>(srv.base, '/indexes/articles/count')
    expect(count.body.count).toBe(IMPORT_DOC_COUNT)

    await assertRoundTrip(srv.base, corpus, IMPORT_DOC_COUNT)
  }, 30_000)
})
