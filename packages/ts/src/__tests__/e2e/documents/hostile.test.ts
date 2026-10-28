import { afterEach, describe, expect, it } from 'vitest'
import { errorCodeOf, errorFieldOf, sendRaw, startDocumentServer, stopDocumentServers } from './harness'

const INDEX = 'orders'
const SCHEMA = {
  title: 'string',
  sku: 'verbatim',
  price: 'number',
  inStock: 'boolean',
  status: 'enum',
  tags: 'string[]',
  scores: 'number[]',
  location: 'geopoint',
  embedding: 'vector[3]',
  shipping: { city: 'string', weight: 'number' },
}
const DOCUMENTS_PATH = `/indexes/${INDEX}/documents`

afterEach(stopDocumentServers)

async function readyServer() {
  const started = await startDocumentServer()
  await started.client.createIndex(INDEX, { schema: SCHEMA })
  return started
}

function nested(depth: number): string {
  return `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`
}

describe('a document request built to break the server', () => {
  it('answers a malformed body with 400 and keeps serving', async () => {
    const { base, client } = await readyServer()
    const bodies: Array<[string, string, string]> = [
      ['truncated JSON', '{"document":{"title":"x"', 'INVALID_JSON'],
      ['plain text', 'not json at all', 'INVALID_JSON'],
      ['an empty body', '', 'EMPTY_BODY'],
      ['a list', '[{"title":"x"}]', 'INVALID_REQUEST'],
      ['a document that is a list', '{"document":[1,2]}', 'INVALID_REQUEST'],
      ['a document that is text', '{"document":"x"}', 'INVALID_REQUEST'],
      ['a document that is null', '{"document":null}', 'INVALID_REQUEST'],
    ]
    for (const [label, body, code] of bodies) {
      const response = await sendRaw(base, 'POST', DOCUMENTS_PATH, body)
      expect([response.status, errorCodeOf(response.body)], label).toEqual([400, code])
    }
    expect(await client.countDocuments(INDEX)).toBe(0)
    expect(await client.insert(INDEX, { title: 'still serving' }, 'after')).toBe('after')
  })

  it('refuses a key that would reach the object prototype, wherever it sits, and leaves the prototype clean', async () => {
    const { base, client } = await readyServer()
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      for (const body of [
        `{"document":{"title":"x","${key}":{"polluted":true}}}`,
        `{"document":{"title":"x","shipping":{"${key}":{"polluted":true}}}}`,
        `{"document":{"title":"x","extra":[{"${key}":{"polluted":true}}]}}`,
      ]) {
        const response = await sendRaw(base, 'POST', DOCUMENTS_PATH, body)
        expect([response.status, errorCodeOf(response.body)], body).toEqual([400, 'DOC_VALIDATION_FAILED'])
      }
    }
    const pollutedFilter = await sendRaw(
      base,
      'POST',
      `/indexes/${INDEX}/search`,
      '{"term":"x","filters":{"fields":{"__proto__":{"eq":"x"}}}}',
    )
    expect(pollutedFilter.status).toBeLessThan(500)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(await client.countDocuments(INDEX)).toBe(0)
  })

  it('refuses a document nested deeper than 32 levels and keeps one at the limit', async () => {
    const { base, client } = await readyServer()
    const tooDeep = await sendRaw(base, 'POST', DOCUMENTS_PATH, `{"id":"deep","document":{"extra":${nested(32)}}}`)
    expect([tooDeep.status, errorCodeOf(tooDeep.body)]).toEqual([400, 'DOC_VALIDATION_FAILED'])
    const atLimit = await sendRaw(base, 'POST', DOCUMENTS_PATH, `{"id":"limit","document":{"extra":${nested(30)}}}`)
    expect(atLimit.status).toBe(201)
    expect(await client.has(INDEX, 'limit')).toBe(true)
  })

  it('refuses each value of the wrong type and names its field', async () => {
    const { base, client } = await readyServer()
    const wrong: Array<[string, string]> = [
      ['title', '{"title":5}'],
      ['price', '{"price":"5"}'],
      ['price', '{"price":1e400}'],
      ['price', '{"price":-1e400}'],
      ['inStock', '{"inStock":"true"}'],
      ['status', '{"status":5}'],
      ['tags', '{"tags":"one"}'],
      ['tags[1]', '{"tags":["one",2]}'],
      ['scores[0]', '{"scores":["1"]}'],
      ['scores[0]', '{"scores":[1e400]}'],
      ['location', '{"location":{"lat":91,"lon":0}}'],
      ['location', '{"location":{"lat":0,"lon":181}}'],
      ['location', '{"location":{"lat":0}}'],
      ['location', '{"location":{"lat":"5","lon":"0"}}'],
      ['location', '{"location":[5,0]}'],
      ['embedding', '{"embedding":[1,2]}'],
      ['embedding', '{"embedding":[1,2,"3"]}'],
      ['embedding', '{"embedding":[1,2,1e400]}'],
      ['shipping', '{"shipping":["Accra"]}'],
      ['shipping.weight', '{"shipping":{"weight":"heavy"}}'],
    ]
    for (const [field, document] of wrong) {
      const response = await sendRaw(base, 'POST', DOCUMENTS_PATH, `{"document":${document}}`)
      const code =
        field === 'location'
          ? 'SCHEMA_INVALID_GEOPOINT'
          : document === '{"embedding":[1,2]}'
            ? 'VECTOR_DIMENSION_MISMATCH'
            : 'DOC_VALIDATION_FAILED'
      expect([response.status, errorCodeOf(response.body)], document).toEqual([400, code])
      expect(String(errorFieldOf(response.body)), document).toContain(field.split('[')[0])
    }
    expect(await client.countDocuments(INDEX)).toBe(0)
  })

  it('refuses each document id that cannot be stored', async () => {
    const { base, client } = await readyServer()
    const ids: Array<[string, unknown]> = [
      ['an empty id', ''],
      ['an id of 513 characters', 'x'.repeat(513)],
      ['an id with a null character', 'a\u0000b'],
      ['a number', 5],
      ['an object', { nested: 'x' }],
    ]
    for (const [label, id] of ids) {
      const response = await sendRaw(base, 'POST', DOCUMENTS_PATH, JSON.stringify({ document: { id, title: 'x' } }))
      expect([response.status, errorCodeOf(response.body)], label).toEqual([400, 'DOC_VALIDATION_FAILED'])
    }
    expect(await client.countDocuments(INDEX)).toBe(0)
    expect(await client.insert(INDEX, { id: 'x'.repeat(512), title: 'x' })).toBe('x'.repeat(512))
  })

  it('reports each malformed entry of a batch on its own and keeps the entries that pass', async () => {
    const { base, client } = await readyServer()
    const response = await sendRaw(
      base,
      'POST',
      `${DOCUMENTS_PATH}/_batch`,
      JSON.stringify({ documents: [null, 5, 'text', [1], { id: 'kept', title: 'ok' }, { id: 'bad', price: 'x' }] }),
    )
    expect(response.status).toBe(200)
    const result = response.body as { succeeded: string[]; failed: Array<{ error: { code: string } }> }
    expect(result.succeeded).toEqual(['kept'])
    expect(result.failed.map(failure => failure.error.code)).toEqual(Array(5).fill('DOC_VALIDATION_FAILED'))
    expect(await client.countDocuments(INDEX)).toBe(1)

    for (const body of [
      { action: 'delete', docIds: [5, null, { id: 'kept' }] },
      { action: 'update', updates: [null, { docId: 5, document: {} }, { docId: 'kept', document: 'x' }] },
    ]) {
      const hostile = await sendRaw(base, 'POST', `${DOCUMENTS_PATH}/_batch`, JSON.stringify(body))
      expect(hostile.status, JSON.stringify(body)).toBeLessThan(500)
    }
    const multiGet = await sendRaw(
      base,
      'POST',
      `${DOCUMENTS_PATH}/_multi-get`,
      JSON.stringify({ docIds: [5, null, 'kept'] }),
    )
    expect(multiGet.status).toBeLessThan(500)
    expect(await client.get(INDEX, 'kept')).toEqual({ id: 'kept', title: 'ok' })
  })

  it('refuses a projection whose field list holds anything but strings, on a search and on a listing', async () => {
    const { base, client } = await readyServer()
    await client.insert(INDEX, { title: 'brass lamp', price: 12, shipping: { city: 'Accra', weight: 2 } }, 'lamp')
    const projections = [
      '{"include":[1]}',
      '{"include":[null]}',
      '{"include":["title",{"path":"price"}]}',
      '{"include":[["title"]]}',
      '{"include":"title"}',
      '{"include":{"0":"title"}}',
      '{"exclude":[true]}',
      '{"exclude":null}',
      '{"include":["title"],"exclude":[5]}',
    ]
    for (const projection of projections) {
      const searched = await sendRaw(
        base,
        'POST',
        `/indexes/${INDEX}/search`,
        `{"term":"lamp","document":${projection}}`,
      )
      expect([searched.status, errorCodeOf(searched.body)], projection).toEqual([400, 'SEARCH_INVALID_FIELD'])
      const listed = await sendRaw(base, 'POST', `${DOCUMENTS_PATH}/_list`, `{"document":${projection}}`)
      expect([listed.status, errorCodeOf(listed.body)], projection).toEqual([400, 'SEARCH_INVALID_FIELD'])
    }

    const reachesPrototype = await sendRaw(
      base,
      'POST',
      `/indexes/${INDEX}/search`,
      '{"term":"lamp","document":{"include":["__proto__.polluted","constructor.prototype.polluted","shipping.city"]}}',
    )
    expect(reachesPrototype.status).toBe(200)
    const hits = (reachesPrototype.body as { hits: Array<{ id: string; document: unknown }> }).hits
    expect(hits.map(hit => [hit.id, hit.document])).toEqual([['lamp', { shipping: { city: 'Accra' } }]])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()

    const kept = await client.query(INDEX, { term: 'lamp', document: { include: ['title'], exclude: ['price'] } })
    expect(kept.hits.map(hit => hit.document)).toEqual([{ title: 'brass lamp' }])
  })

  it('answers a body past the size limit with 413 and keeps serving', async () => {
    const { base, client } = await startDocumentServer(undefined, { limits: { maxBodyBytes: 4_096 } })
    await client.createIndex(INDEX, { schema: SCHEMA })
    const response = await sendRaw(
      base,
      'POST',
      DOCUMENTS_PATH,
      JSON.stringify({ document: { title: 'x'.repeat(10_000) } }),
    )
    expect([response.status, errorCodeOf(response.body)]).toEqual([413, 'PAYLOAD_TOO_LARGE'])
    expect(await client.insert(INDEX, { title: 'small' }, 'small')).toBe('small')
  })
})
