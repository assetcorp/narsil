import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'

describe('query options that name a field on a strict index', () => {
  let narsil: Narsil

  beforeAll(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('bikes', { schema: { name: 'string', price: 'number' }, strict: true })
    await narsil.createIndex('loose-bikes', { schema: { name: 'string', price: 'number' } })
    const bikes = [
      { id: 'a-urban', name: 'Urban bike', price: 700 },
      { id: 'b-trail', name: 'Trail bike', price: 1400 },
    ]
    await narsil.insertBatch('bikes', bikes)
    await narsil.insertBatch('loose-bikes', bikes)
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  it('raises SEARCH_INVALID_FIELD for a filter, sort, facet, or group on a field the schema never declares', async () => {
    const misspelt = [
      { term: 'bike', filters: { fields: { prcie: { lt: 800 } } } },
      { term: 'bike', sort: { prcie: 'asc' as const } },
      { term: 'bike', facets: { prcie: {} } },
      { term: 'bike', group: { fields: ['prcie'] } },
    ]
    for (const query of misspelt) {
      await expect(narsil.query('bikes', query)).rejects.toMatchObject({ code: 'SEARCH_INVALID_FIELD' })
    }
    await expect(narsil.preflight('bikes', misspelt[0])).rejects.toMatchObject({ code: 'SEARCH_INVALID_FIELD' })
    await expect(narsil.listDocuments('bikes', { filters: { fields: { prcie: { lt: 800 } } } })).rejects.toMatchObject({
      code: 'SEARCH_INVALID_FIELD',
    })
  })

  it('checks a field named inside a nested clause', async () => {
    await expect(
      narsil.query('bikes', {
        term: 'bike',
        filters: { or: [{ fields: { price: { lt: 800 } } }, { fields: { prcie: { gt: 1 } } }] },
      }),
    ).rejects.toMatchObject({ code: 'SEARCH_INVALID_FIELD' })
  })

  it('answers the same options on declared fields', async () => {
    const result = await narsil.query('bikes', {
      term: 'bike',
      filters: { fields: { price: { lt: 800 } } },
      sort: { price: 'asc' },
      facets: { price: {} },
    })
    expect(result.hits.map(hit => hit.id)).toEqual(['a-urban'])
  })

  it('keeps reading stored values for an undeclared field on an index that is not strict', async () => {
    const result = await narsil.query('loose-bikes', { term: 'bike', filters: { fields: { prcie: { lt: 800 } } } })
    expect(result.count).toBe(0)
  })
})
