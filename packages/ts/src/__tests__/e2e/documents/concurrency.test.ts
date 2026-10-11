import { afterEach, describe, expect, it } from 'vitest'
import { sendRaw, startDocumentServer, stopDocumentServers } from './harness'

const INDEX = 'orders'
const SCHEMA = { title: 'string', sku: 'verbatim', price: 'number' }
const CLIENTS = 20

afterEach(stopDocumentServers)

describe('documents written by many clients at once', () => {
  it('upserts one new id from every client without a conflict, keeping one of their versions', async () => {
    const { base, client } = await startDocumentServer()
    await client.createIndex(INDEX, { schema: SCHEMA })
    const versions = Array.from({ length: CLIENTS }, (_, at) => ({ title: `version ${at}`, price: at }))
    const responses = await Promise.all(
      versions.map(document =>
        sendRaw(base, 'PUT', `/indexes/${INDEX}/documents/shared`, JSON.stringify({ document })),
      ),
    )
    expect(responses.map(response => response.status).filter(status => status >= 300)).toEqual([])
    expect(responses.filter(response => response.status === 201)).toHaveLength(1)
    expect(versions).toContainEqual(await client.get(INDEX, 'shared'))
    expect(await client.countDocuments(INDEX)).toBe(1)
  })

  it('keeps every document that clients insert at once and finds each one by search', async () => {
    const { client } = await startDocumentServer()
    await client.createIndex(INDEX, { schema: SCHEMA })
    const ids = Array.from({ length: 200 }, (_, at) => `o-${at}`)
    const searches: Promise<unknown>[] = []
    await Promise.all(
      ids.map((id, at) => {
        if (at % 10 === 0) searches.push(client.query(INDEX, { term: 'parcel' }))
        return client.insert(INDEX, { title: `parcel ${id}`, sku: id, price: at }, id)
      }),
    )
    await Promise.all(searches)
    expect(await client.countDocuments(INDEX)).toBe(ids.length)
    const found = await client.query(INDEX, { term: 'parcel', limit: 1_000 })
    expect(found.hits.map(hit => hit.id).sort()).toEqual([...ids].sort())
    for (const id of ['o-0', 'o-199']) {
      const exact = await client.query(INDEX, { term: 'parcel', filters: { fields: { sku: { eq: id } } } })
      expect(exact.hits.map(hit => hit.id)).toEqual([id])
    }
  })

  it('leaves each document in one consistent state when clients update and remove it at once', async () => {
    const { base, client } = await startDocumentServer()
    await client.createIndex(INDEX, { schema: SCHEMA })
    const ids = Array.from({ length: 30 }, (_, at) => `o-${at}`)
    await client.insertBatch(
      INDEX,
      ids.map(id => ({ id, title: 'original parcel', price: 1 })),
    )
    const requests = ids.flatMap(id => [
      sendRaw(
        base,
        'PATCH',
        `/indexes/${INDEX}/documents/${id}`,
        JSON.stringify({ document: { title: 'updated parcel', price: 2 } }),
      ),
      sendRaw(base, 'DELETE', `/indexes/${INDEX}/documents/${id}`),
      sendRaw(
        base,
        'PATCH',
        `/indexes/${INDEX}/documents/${id}`,
        JSON.stringify({ document: { title: 'updated again', price: 3 } }),
      ),
    ])
    const responses = await Promise.all(requests)
    expect(responses.map(response => response.status).filter(status => status >= 500)).toEqual([])
    for (const response of responses) expect([200, 404], JSON.stringify(response.body)).toContain(response.status)

    const stored = await client.getMultiple(INDEX, ids)
    const listed = await client.query(INDEX, { term: 'parcel', limit: 1_000 })
    const searchable = new Set(listed.hits.map(hit => hit.id))
    for (const id of ids) {
      const document = stored.get(id)
      if (document === undefined) {
        expect(searchable.has(id), id).toBe(false)
        continue
      }
      expect(
        [
          { title: 'updated parcel', price: 2 },
          { title: 'updated again', price: 3 },
        ],
        id,
      ).toContainEqual(document)
      expect(searchable.has(id), id).toBe(document.title === 'updated parcel')
    }
    expect(await client.countDocuments(INDEX)).toBe(stored.size)
  })
})
