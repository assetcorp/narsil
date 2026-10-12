import { afterEach, describe, expect, it } from 'vitest'
import type { AnyDocument } from '../../../types/schema'
import { errorCodeOf, sendRaw, startDocumentServer, stopDocumentServers } from './harness'

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
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(stopDocumentServers)

function fullOrder(id: string): AnyDocument {
  return {
    id,
    title: 'Trackball mouse, wireless',
    sku: 'SKU-001',
    price: 49.95,
    inStock: true,
    status: 'shipped',
    tags: ['input', 'wireless', ''],
    scores: [0, -1.5, 1e21, Number.MAX_SAFE_INTEGER],
    location: { lat: 5.6037, lon: -0.187 },
    embedding: [0.25, -0.5, 1],
    shipping: { city: 'Accra', weight: 0.42 },
    notInSchema: { nested: [1, 'two', { three: 3 }], empty: {}, list: [] },
  }
}

describe('a document written and read over HTTP', () => {
  it('comes back exactly as sent, every field type and every field outside the schema included', async () => {
    const { client } = await startDocumentServer()
    await client.createIndex(INDEX, { schema: SCHEMA })
    const order = fullOrder('o-1')
    expect(await client.insert(INDEX, order)).toBe('o-1')
    expect(await client.get(INDEX, 'o-1')).toEqual(order)
    expect((await client.getMultiple(INDEX, ['o-1'])).get('o-1')).toEqual(order)
  })

  it('takes its id from the argument or else from the document, refuses the two when they differ, and otherwise generates a UUID version 7', async () => {
    const { base, client } = await startDocumentServer()
    await client.createIndex(INDEX, { schema: SCHEMA })
    const contradicting = await sendRaw(
      base,
      'POST',
      `/indexes/${INDEX}/documents`,
      JSON.stringify({ id: 'from-argument', document: { id: 'from-document', title: 'a' } }),
    )
    expect([contradicting.status, errorCodeOf(contradicting.body)]).toEqual([400, 'DOC_VALIDATION_FAILED'])
    const contradictingPut = await sendRaw(
      base,
      'PUT',
      `/indexes/${INDEX}/documents/from-path`,
      JSON.stringify({ document: { id: 'from-body', title: 'a' } }),
    )
    expect([contradictingPut.status, errorCodeOf(contradictingPut.body)]).toEqual([400, 'DOC_VALIDATION_FAILED'])
    expect(await client.countDocuments(INDEX)).toBe(0)
    expect(await client.insert(INDEX, { title: 'a' }, 'from-argument')).toBe('from-argument')
    expect(await client.insert(INDEX, { id: 'from-document', title: 'b' })).toBe('from-document')
    await client.update(INDEX, 'from-document', { id: 'from-document', title: 'c' })
    const contradictingUpdate = await sendRaw(
      base,
      'PATCH',
      `/indexes/${INDEX}/documents/from-document`,
      JSON.stringify({ document: { id: 'someone-else', title: 'd' } }),
    )
    expect([contradictingUpdate.status, errorCodeOf(contradictingUpdate.body)]).toEqual([400, 'DOC_VALIDATION_FAILED'])
    expect(await client.get(INDEX, 'from-document')).toEqual({ id: 'from-document', title: 'c' })
    const generated = new Set<string>()
    for (let at = 0; at < 50; at++) generated.add(await client.insert(INDEX, { title: `generated ${at}` }))
    expect(generated.size).toBe(50)
    for (const id of generated) expect(id).toMatch(UUID_V7)
    expect(await client.countDocuments(INDEX)).toBe(52)
  })

  it('replaces the whole document on update, so a field left out is gone', async () => {
    const { client } = await startDocumentServer()
    await client.createIndex(INDEX, { schema: SCHEMA })
    await client.insert(INDEX, fullOrder('o-1'))
    await client.update(INDEX, 'o-1', { title: 'Renamed', price: 10 })
    expect(await client.get(INDEX, 'o-1')).toEqual({ title: 'Renamed', price: 10 })
    const found = await client.query(INDEX, { term: 'trackball' })
    expect(found.count).toBe(0)
    expect((await client.query(INDEX, { term: 'renamed' })).hits.map(hit => hit.id)).toEqual(['o-1'])
  })

  it('answers an upsert with created on the first PUT and updated on the next', async () => {
    const { base, client } = await startDocumentServer()
    await client.createIndex(INDEX, { schema: SCHEMA })
    const first = await sendRaw(
      base,
      'PUT',
      `/indexes/${INDEX}/documents/o-9`,
      JSON.stringify({ document: { title: 'v1' } }),
    )
    expect(first).toEqual({ status: 201, body: { id: 'o-9', created: true } })
    const second = await sendRaw(
      base,
      'PUT',
      `/indexes/${INDEX}/documents/o-9`,
      JSON.stringify({ document: { title: 'v2' } }),
    )
    expect(second).toEqual({ status: 200, body: { id: 'o-9', created: false } })
    expect(await client.get(INDEX, 'o-9')).toEqual({ title: 'v2' })
  })

  it('answers each missing index and missing document with its own not-found code', async () => {
    const { base, client } = await startDocumentServer()
    await client.createIndex(INDEX, { schema: SCHEMA })
    const missingIndex: Array<[string, string, string | undefined]> = [
      ['GET', '/indexes/nowhere/documents/x', undefined],
      ['POST', '/indexes/nowhere/documents', JSON.stringify({ document: { title: 'x' } })],
      ['PUT', '/indexes/nowhere/documents/x', JSON.stringify({ document: { title: 'x' } })],
      ['PATCH', '/indexes/nowhere/documents/x', JSON.stringify({ document: { title: 'x' } })],
      ['DELETE', '/indexes/nowhere/documents/x', undefined],
      ['POST', '/indexes/nowhere/search', JSON.stringify({ term: 'x' })],
      ['GET', '/indexes/nowhere/count', undefined],
    ]
    for (const [method, path, body] of missingIndex) {
      const response = await sendRaw(base, method, path, body)
      expect([response.status, errorCodeOf(response.body)], `${method} ${path}`).toEqual([404, 'INDEX_NOT_FOUND'])
    }
    for (const [method, body] of [
      ['GET', undefined],
      ['PATCH', JSON.stringify({ document: { title: 'x' } })],
      ['DELETE', undefined],
    ] as const) {
      const response = await sendRaw(base, method, `/indexes/${INDEX}/documents/absent`, body)
      expect([response.status, errorCodeOf(response.body)], method).toEqual([404, 'DOC_NOT_FOUND'])
    }
    await client.insert(INDEX, { id: 'once', title: 'x' })
    const twice = await sendRaw(
      base,
      'POST',
      `/indexes/${INDEX}/documents`,
      JSON.stringify({ id: 'once', document: { title: 'y' } }),
    )
    expect([twice.status, errorCodeOf(twice.body)]).toEqual([409, 'DOC_ALREADY_EXISTS'])
    expect(await client.get(INDEX, 'once')).toEqual({ id: 'once', title: 'x' })
  })

  it('reports each entry of a batch on its own and keeps the entries that pass', async () => {
    const { client } = await startDocumentServer()
    await client.createIndex(INDEX, { schema: SCHEMA })
    await client.insert(INDEX, { id: 'existing', title: 'x' })
    const inserted = await client.insertBatch(INDEX, [
      { id: 'b-1', title: 'ok' },
      { id: 'existing', title: 'duplicate of a stored id' },
      { id: 'b-2', price: 'not a number' },
      { id: 'b-3', title: 'ok' },
      { id: 'b-3', title: 'second copy in the same batch' },
    ])
    expect(inserted.succeeded.sort()).toEqual(['b-1', 'b-3'])
    expect(inserted.failed.map(failure => [failure.docId, failure.error.code]).sort()).toEqual([
      ['b-2', 'DOC_VALIDATION_FAILED'],
      ['b-3', 'DOC_ALREADY_EXISTS'],
      ['existing', 'DOC_ALREADY_EXISTS'],
    ])
    expect(await client.get(INDEX, 'b-3')).toEqual({ id: 'b-3', title: 'ok' })

    const removed = await client.removeBatch(INDEX, ['b-1', 'absent', 'b-1'])
    expect(removed.succeeded).toEqual(['b-1'])
    expect(removed.failed.map(failure => [failure.docId, failure.error.code])).toEqual([
      ['absent', 'DOC_NOT_FOUND'],
      ['b-1', 'DOC_NOT_FOUND'],
    ])
    const updated = await client.updateBatch(INDEX, [
      { docId: 'b-3', document: { title: 'changed' } },
      { docId: 'absent', document: { title: 'never' } },
    ])
    expect(updated.succeeded).toEqual(['b-3'])
    expect(updated.failed.map(failure => [failure.docId, failure.error.code])).toEqual([['absent', 'DOC_NOT_FOUND']])
    expect(await client.countDocuments(INDEX)).toBe(2)
  })
})
