import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsilClient, type HttpIndexConfig, type NarsilClient } from '../../client'
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
  const created = new Set<string>()
  let indexesCreated = 0

  beforeAll(async () => {
    server = await startTestServer()
    client = createNarsilClient({ url: server.base })
  })

  afterAll(async () => {
    await server.stop()
  })

  async function createUniqueIndex(config: HttpIndexConfig = { schema: SCHEMA, language: 'english' }): Promise<string> {
    indexesCreated += 1
    const name = `movies-${indexesCreated}`
    await client.createIndex(name, config)
    created.add(name)
    return name
  }

  async function listedNames(): Promise<string[]> {
    return (await client.listIndexes()).map(entry => entry.name).sort()
  }

  it('sends a vector as numbers, whether it arrives as an array or a Float32Array', async () => {
    const index = await createUniqueIndex({ schema: { title: 'string', embedding: 'vector[3]' }, language: 'english' })
    await client.insert(index, { id: 'v1', title: 'typed', embedding: new Float32Array([1, 0, 0]) })
    await client.insert(index, { id: 'v2', title: 'plain', embedding: [0, 1, 0] })

    const typed = await client.get(index, 'v1', { vectors: true })
    const plain = await client.get(index, 'v2', { vectors: true })
    expect({ typed: typed?.embedding, plain: plain?.embedding }).toEqual({ typed: [1, 0, 0], plain: [0, 1, 0] })

    const found = await client.query(index, {
      mode: 'vector',
      vector: { field: 'embedding', value: new Float32Array([1, 0, 0]) },
      limit: 1,
    })
    expect(found.hits.map(hit => hit.id)).toEqual(['v1'])
  })

  it('creates, describes, and drops an index', async () => {
    const index = await createUniqueIndex()
    expect(await listedNames()).toEqual([...created].sort())

    const stats = await client.getStats(index)
    expect(stats.documentCount).toBe(0)
    expect(stats.language).toBe('english')
    expect(stats.schema).toEqual(SCHEMA)

    expect(await client.getPartitionStats(index)).toHaveLength(1)

    await client.dropIndex(index)
    created.delete(index)
    expect(await listedNames()).toEqual([...created].sort())
  })

  it('refuses a second index of the same name with the code the server sent', async () => {
    const index = await createUniqueIndex()
    const failure = await client
      .createIndex(index, { schema: SCHEMA, language: 'english' })
      .catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(NarsilError)
    expect((failure as NarsilError).code).toBe('INDEX_ALREADY_EXISTS')
    expect((failure as NarsilError).details.status).toBe(409)
  })

  it('writes and reads one document at a time', async () => {
    const index = await createUniqueIndex()
    const id = await client.insert(index, { title: 'The Matrix', year: 1999 }, 'm-matrix')
    expect(id).toBe('m-matrix')
    expect(await client.has(index, 'm-matrix')).toBe(true)
    expect(await client.get(index, 'm-matrix')).toMatchObject({ title: 'The Matrix' })
    expect(await client.countDocuments(index)).toBe(1)

    await client.update(index, 'm-matrix', { title: 'The Matrix Reloaded', year: 2003 })
    expect(await client.get(index, 'm-matrix')).toMatchObject({ title: 'The Matrix Reloaded' })

    await client.remove(index, 'm-matrix')
    expect(await client.has(index, 'm-matrix')).toBe(false)
  })

  it('reports a missing document as undefined and a missing index as an error', async () => {
    const index = await createUniqueIndex()
    expect(await client.get(index, 'absent')).toBeUndefined()
    const failure = await client.get('nothing', 'absent').catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(NarsilError)
    expect((failure as NarsilError).code).toBe('INDEX_NOT_FOUND')
  })

  it('says whether an upsert created the document or replaced one', async () => {
    const index = await createUniqueIndex()
    expect(await client.put(index, 'm1', { title: 'First', year: 2001 })).toEqual({ id: 'm1', created: true })
    expect(await client.put(index, 'm1', { title: 'Second', year: 2002 })).toEqual({ id: 'm1', created: false })
    expect(await client.get(index, 'm1')).toMatchObject({ title: 'Second' })
  })

  it('writes a batch and reports each refusal as an error carrying its code', async () => {
    const index = await createUniqueIndex()
    const written = await client.insertBatch(index, [...movies(3), { id: 'bad', title: 'Wrong', year: 'text' }])
    expect(written.succeeded).toEqual(['m0', 'm1', 'm2'])
    expect(written.failed).toHaveLength(1)
    expect(written.failed[0].docId).toBe('bad')
    expect(written.failed[0].error).toBeInstanceOf(NarsilError)
    expect(written.failed[0].error.code).toBe('DOC_VALIDATION_FAILED')
  })

  it('updates and removes documents in batches', async () => {
    const index = await createUniqueIndex()
    await client.insertBatch(index, movies(3))
    const updated = await client.updateBatch(index, [{ docId: 'm0', document: { title: 'Changed', year: 2020 } }])
    expect(updated.succeeded).toEqual(['m0'])
    expect(await client.get(index, 'm0')).toMatchObject({ title: 'Changed' })

    const removed = await client.removeBatch(index, ['m1', 'm2'])
    expect(removed.succeeded).toEqual(['m1', 'm2'])
    expect(await client.countDocuments(index)).toBe(1)
  })

  it('reads many documents by id and leaves out the ones the index does not hold', async () => {
    const index = await createUniqueIndex()
    await client.insertBatch(index, movies(3))
    const found = await client.getMultiple(index, ['m0', 'm2', 'absent'])
    expect([...found.keys()]).toEqual(['m0', 'm2'])
    expect(found.get('m0')).toMatchObject({ title: 'Movie 0' })
  })

  it('pages through stored documents with the cursor the server returns', async () => {
    const index = await createUniqueIndex()
    await client.insertBatch(index, movies(5))
    const first = await client.listDocuments(index, { limit: 2 })
    expect(first.documents).toHaveLength(2)
    expect(first.total).toBe(5)
    expect(first.cursor).not.toBeNull()

    const second = await client.listDocuments(index, { limit: 2, cursor: first.cursor ?? undefined })
    expect(second.documents.map(entry => entry.id)).not.toEqual(first.documents.map(entry => entry.id))
  })

  it('searches, counts, and completes a prefix', async () => {
    const index = await createUniqueIndex()
    await client.insertBatch(index, [
      { id: 'a', title: 'The Matrix', year: 1999 },
      { id: 'b', title: 'Matrix Reloaded', year: 2003 },
      { id: 'c', title: 'Casablanca', year: 1942 },
    ])

    const results = await client.query(index, { term: 'matrix', fields: ['title'] })
    expect(results.count).toBe(2)
    expect(results.hits.map(hit => hit.id).sort()).toEqual(['a', 'b'])

    expect((await client.preflight(index, { term: 'matrix', fields: ['title'] })).count).toBe(2)
    expect((await client.suggest(index, { prefix: 'matr' })).terms[0].term).toBe('matrix')
  })

  it('empties an index and keeps its schema', async () => {
    const index = await createUniqueIndex()
    await client.insertBatch(index, movies(3))
    await client.clear(index)
    expect(await client.countDocuments(index)).toBe(0)
    expect((await client.getStats(index)).schema).toEqual(SCHEMA)
  })

  it('round-trips a document id that holds a slash, a space, and an accent', async () => {
    const index = await createUniqueIndex()
    const docId = 'tt/0133093 Amélie'
    await client.put(index, docId, { title: 'The Matrix', year: 1999 })

    expect(await client.has(index, docId)).toBe(true)
    expect(await client.get(index, docId)).toMatchObject({ title: 'The Matrix' })

    await client.remove(index, docId)
    expect(await client.has(index, docId)).toBe(false)
  })
})
