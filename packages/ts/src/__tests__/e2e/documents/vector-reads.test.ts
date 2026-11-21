import { afterEach, describe, expect, it } from 'vitest'
import { errorCodeOf, sendRaw, startDocumentServer, stopDocumentServers } from './harness'

const SCHEMA = { title: 'string', embedding: 'vector[3]', meta: { sketch: 'vector[2]' } }
const SKETCH = [0.375, -0.625]
const EMBEDDING = [0.1, -0.2, 0.3]
const BOOK = { id: 'book-1', title: 'harbour lights', embedding: EMBEDDING, meta: { sketch: SKETCH } }
const WITH_VECTORS = { ...BOOK, embedding: EMBEDDING.map(Math.fround) }
const WITHOUT_VECTORS = { id: BOOK.id, title: BOOK.title, meta: {} }

afterEach(stopDocumentServers)

async function serveBooks(): Promise<string> {
  const { base } = await startDocumentServer()
  for (const [name, config] of [
    ['plain', { schema: SCHEMA }],
    ['kept', { schema: SCHEMA, returnVectors: true }],
  ] as const) {
    const created = await sendRaw(base, 'POST', '/indexes', JSON.stringify({ name, config }))
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const inserted = await sendRaw(
      base,
      'POST',
      `/indexes/${name}/documents?wait=true`,
      JSON.stringify({ document: BOOK }),
    )
    expect(inserted.status, JSON.stringify(inserted.body)).toBeLessThan(300)
  }
  return base
}

interface ReadAnswers {
  single: unknown
  multi: unknown
  searched: unknown
  listed: unknown
}

async function readEveryWay(base: string, name: string, query: string, document?: unknown): Promise<ReadAnswers> {
  const shaped = document === undefined ? {} : { document }
  const single = await sendRaw(base, 'GET', `/indexes/${name}/documents/${BOOK.id}${query}`)
  const multi = await sendRaw(
    base,
    'POST',
    `/indexes/${name}/documents/_multi-get`,
    JSON.stringify({ docIds: [BOOK.id], ...shaped }),
  )
  const searched = await sendRaw(
    base,
    'POST',
    `/indexes/${name}/search`,
    JSON.stringify({ term: 'harbour', ...shaped }),
  )
  const listed = await sendRaw(
    base,
    'POST',
    `/indexes/${name}/documents/_list`,
    JSON.stringify({ limit: 5, ...shaped }),
  )
  for (const answer of [single, multi, searched, listed]) expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return {
    single: (single.body as { document: unknown }).document,
    multi: (multi.body as { documents: Record<string, unknown> }).documents[BOOK.id],
    searched: (searched.body as { hits: Array<{ document: unknown }> }).hits[0]?.document,
    listed: (listed.body as { documents: Array<{ document: unknown }> }).documents[0]?.document,
  }
}

function projectionRoutes(document: string): Array<[string, string]> {
  return [
    ['/indexes/plain/search', `{"term":"harbour","document":${document}}`],
    ['/indexes/plain/search/preflight', `{"term":"harbour","document":${document}}`],
    ['/indexes/plain/documents/_list', `{"document":${document}}`],
    ['/indexes/plain/documents/_multi-get', `{"docIds":["${BOOK.id}"],"document":${document}}`],
  ]
}

function everyWay(document: unknown, single: unknown = document): ReadAnswers {
  return { single, multi: document, searched: document, listed: document }
}

describe('vector fields in documents read over HTTP', () => {
  it('leaves them out by default, returns them when the read or the index asks, and lets the read turn them off', async () => {
    const base = await serveBooks()
    expect(await readEveryWay(base, 'plain', '')).toEqual(everyWay(WITHOUT_VECTORS))
    expect(await readEveryWay(base, 'plain', '?vectors=true', { vectors: true })).toEqual(everyWay(WITH_VECTORS))
    expect(await readEveryWay(base, 'kept', '')).toEqual(everyWay(WITH_VECTORS))
    expect(await readEveryWay(base, 'kept', '?vectors=false', { vectors: false })).toEqual(everyWay(WITHOUT_VECTORS))
    expect(await readEveryWay(base, 'plain', '', { include: ['meta.sketch'] })).toEqual(
      everyWay({ meta: { sketch: SKETCH } }, WITHOUT_VECTORS),
    )
  })

  it('reads a null vectors switch and an empty vectors parameter as absent on every read', async () => {
    const base = await serveBooks()
    const nothingSet = { include: null, exclude: null, vectors: null }
    expect(await readEveryWay(base, 'plain', '?vectors=', nothingSet)).toEqual(everyWay(WITHOUT_VECTORS))
    expect(await readEveryWay(base, 'kept', '?vectors', nothingSet)).toEqual(everyWay(WITH_VECTORS))
  })

  it('refuses a vectors switch or a returnVectors setting that is not true or false', async () => {
    const base = await serveBooks()
    for (const value of ['yes', 'TRUE', '1', 'true%00']) {
      const answer = await sendRaw(base, 'GET', `/indexes/plain/documents/${BOOK.id}?vectors=${value}`)
      expect([answer.status, errorCodeOf(answer.body)], value).toEqual([400, 'SEARCH_INVALID_FIELD'])
    }
    for (const vectors of ['true', 1, null, [true], {}]) {
      const document = JSON.stringify({ vectors })
      const routes = [
        ['/indexes/plain/search', `{"term":"harbour","document":${document}}`],
        ['/indexes/plain/search/preflight', `{"term":"harbour","document":${document}}`],
        ['/indexes/plain/documents/_list', `{"document":${document}}`],
        ['/indexes/plain/documents/_multi-get', `{"docIds":["${BOOK.id}"],"document":${document}}`],
      ]
      for (const [path, body] of vectors === null ? [] : routes) {
        const answer = await sendRaw(base, 'POST', path, body)
        expect([answer.status, errorCodeOf(answer.body)], `${path} ${document}`).toEqual([400, 'SEARCH_INVALID_FIELD'])
      }
      for (const setting of ['returnVectors', 'strict', 'surfaceForms', 'trackPositions']) {
        const created = await sendRaw(
          base,
          'POST',
          '/indexes',
          JSON.stringify({ name: 'refused', config: { schema: SCHEMA, [setting]: vectors } }),
        )
        expect([created.status, errorCodeOf(created.body)], `${setting} ${document}`).toEqual([400, 'CONFIG_INVALID'])
      }
    }
    const indexes = await sendRaw(base, 'GET', '/indexes')
    expect(JSON.stringify(indexes.body)).not.toContain('refused')
  })

  it('refuses a search projection that is not true, false, or an object of field path lists', async () => {
    const base = await serveBooks()
    for (const document of [
      '5',
      '"all"',
      '[]',
      '{"include":5}',
      '{"include":[1]}',
      '{"exclude":"title"}',
      '{"exclude":[true]}',
      '{"vectors":"true"}',
    ]) {
      for (const [path, body] of projectionRoutes(document)) {
        const answer = await sendRaw(base, 'POST', path, body)
        expect([answer.status, errorCodeOf(answer.body)], `${path} ${document}`).toEqual([400, 'SEARCH_INVALID_FIELD'])
      }
    }
    for (const [path, body] of projectionRoutes('null')) {
      const answer = await sendRaw(base, 'POST', path, body)
      expect(answer.status, `${path} with a null projection: ${JSON.stringify(answer.body)}`).toBe(200)
    }
  })
})
