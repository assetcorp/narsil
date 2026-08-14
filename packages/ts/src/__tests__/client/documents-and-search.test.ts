import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../client'
import { NarsilError } from '../../errors'
import { startTestServer, type TestServer } from '../server/helpers'

const SCHEMA = { title: 'string', year: 'number' }

function movies(count: number, from = 0): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${from + index}`,
    title: `Movie ${from + index}`,
    year: 2000 + ((from + index) % 20),
  }))
}

describe('client against a live server', () => {
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

  it('creates, describes, and drops an index', async () => {
    const listed = await client.listIndexes()
    expect(listed.map(entry => entry.name)).toEqual(['movies'])

    const stats = await client.getStats('movies')
    expect(stats.documentCount).toBe(0)
    expect(stats.language).toBe('english')
    expect(stats.schema).toEqual(SCHEMA)

    expect(await client.getPartitionStats('movies')).toHaveLength(1)

    await client.dropIndex('movies')
    expect(await client.listIndexes()).toEqual([])
  })

  it('refuses a second index of the same name with the code the server sent', async () => {
    const failure = await client
      .createIndex('movies', { schema: SCHEMA, language: 'english' })
      .catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(NarsilError)
    expect((failure as NarsilError).code).toBe('INDEX_ALREADY_EXISTS')
    expect((failure as NarsilError).details.status).toBe(409)
  })

  it('writes and reads one document at a time', async () => {
    const id = await client.insert('movies', { title: 'The Matrix', year: 1999 }, 'm-matrix')
    expect(id).toBe('m-matrix')
    expect(await client.has('movies', 'm-matrix')).toBe(true)
    expect(await client.get('movies', 'm-matrix')).toMatchObject({ title: 'The Matrix' })
    expect(await client.countDocuments('movies')).toBe(1)

    await client.update('movies', 'm-matrix', { title: 'The Matrix Reloaded', year: 2003 })
    expect(await client.get('movies', 'm-matrix')).toMatchObject({ title: 'The Matrix Reloaded' })

    await client.remove('movies', 'm-matrix')
    expect(await client.has('movies', 'm-matrix')).toBe(false)
  })

  it('reports a missing document as undefined and a missing index as an error', async () => {
    expect(await client.get('movies', 'absent')).toBeUndefined()
    const failure = await client.get('nothing', 'absent').catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(NarsilError)
    expect((failure as NarsilError).code).toBe('INDEX_NOT_FOUND')
  })

  it('says whether an upsert created the document or replaced one', async () => {
    expect(await client.put('movies', 'm1', { title: 'First', year: 2001 })).toEqual({ id: 'm1', created: true })
    expect(await client.put('movies', 'm1', { title: 'Second', year: 2002 })).toEqual({ id: 'm1', created: false })
    expect(await client.get('movies', 'm1')).toMatchObject({ title: 'Second' })
  })

  it('writes a batch and reports each refusal as an error carrying its code', async () => {
    const written = await client.insertBatch('movies', [...movies(3), { id: 'bad', title: 'Wrong', year: 'text' }])
    expect(written.succeeded).toEqual(['m0', 'm1', 'm2'])
    expect(written.failed).toHaveLength(1)
    expect(written.failed[0].docId).toBe('bad')
    expect(written.failed[0].error).toBeInstanceOf(NarsilError)
    expect(written.failed[0].error.code).toBe('DOC_VALIDATION_FAILED')
  })

  it('updates and removes documents in batches', async () => {
    await client.insertBatch('movies', movies(3))
    const updated = await client.updateBatch('movies', [{ docId: 'm0', document: { title: 'Changed', year: 2020 } }])
    expect(updated.succeeded).toEqual(['m0'])
    expect(await client.get('movies', 'm0')).toMatchObject({ title: 'Changed' })

    const removed = await client.removeBatch('movies', ['m1', 'm2'])
    expect(removed.succeeded).toEqual(['m1', 'm2'])
    expect(await client.countDocuments('movies')).toBe(1)
  })

  it('reads many documents by id and leaves out the ones the index does not hold', async () => {
    await client.insertBatch('movies', movies(3))
    const found = await client.getMultiple('movies', ['m0', 'm2', 'absent'])
    expect([...found.keys()]).toEqual(['m0', 'm2'])
    expect(found.get('m0')).toMatchObject({ title: 'Movie 0' })
  })

  it('pages through stored documents with the cursor the server returns', async () => {
    await client.insertBatch('movies', movies(5))
    const first = await client.listDocuments('movies', { limit: 2 })
    expect(first.documents).toHaveLength(2)
    expect(first.total).toBe(5)
    expect(first.cursor).not.toBeNull()

    const second = await client.listDocuments('movies', { limit: 2, cursor: first.cursor ?? undefined })
    expect(second.documents.map(entry => entry.id)).not.toEqual(first.documents.map(entry => entry.id))
  })

  it('searches, counts, and completes a prefix', async () => {
    await client.insertBatch('movies', [
      { id: 'a', title: 'The Matrix', year: 1999 },
      { id: 'b', title: 'Matrix Reloaded', year: 2003 },
      { id: 'c', title: 'Casablanca', year: 1942 },
    ])

    const results = await client.query('movies', { term: 'matrix', fields: ['title'] })
    expect(results.count).toBe(2)
    expect(results.hits.map(hit => hit.id).sort()).toEqual(['a', 'b'])

    expect((await client.preflight('movies', { term: 'matrix', fields: ['title'] })).count).toBe(2)
    expect((await client.suggest('movies', { prefix: 'matr' })).terms[0].term).toBe('matrix')
  })

  it('empties an index and keeps its schema', async () => {
    await client.insertBatch('movies', movies(3))
    await client.clear('movies')
    expect(await client.countDocuments('movies')).toBe(0)
    expect((await client.getStats('movies')).schema).toEqual(SCHEMA)
  })

  it('round-trips a document id that holds a slash, a space, and an accent', async () => {
    const docId = 'tt/0133093 Amélie'
    await client.put('movies', docId, { title: 'The Matrix', year: 1999 })

    expect(await client.has('movies', docId)).toBe(true)
    expect(await client.get('movies', docId)).toMatchObject({ title: 'The Matrix' })

    await client.remove('movies', docId)
    expect(await client.has('movies', docId)).toBe(false)
  })
})
