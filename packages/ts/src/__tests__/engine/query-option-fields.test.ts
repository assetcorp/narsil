import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { SortSpec } from '../../types/search'

describe('query options that name a field', () => {
  let narsil: Narsil

  beforeAll(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('bikes', {
      schema: { name: 'string', price: 'number', category: 'enum', depot: 'geopoint' },
    })
    await narsil.insertBatch('bikes', [
      { id: 'a-urban', name: 'Urban bike', price: 700, category: 'city', weight: 12 },
      { id: 'b-trail', name: 'Trail bike bike', price: 1400, category: 'mountain', weight: 14 },
      { id: 'c-cargo', name: 'Cargo bike bike bike', price: 2100, category: 'city' },
    ])
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  it('raises SEARCH_INVALID_MODE for a sort direction other than asc and desc', async () => {
    const sort = { price: 'up' } as unknown as SortSpec
    await expect(narsil.query('bikes', { term: 'bike', sort })).rejects.toMatchObject({
      code: 'SEARCH_INVALID_MODE',
    })
    await expect(narsil.listDocuments('bikes', { sort })).rejects.toMatchObject({ code: 'SEARCH_INVALID_MODE' })
  })

  it('raises SEARCH_INVALID_FIELD for a boost on a field outside the schema or on a number field', async () => {
    await expect(narsil.query('bikes', { term: 'bike', boost: { weight: 5 } })).rejects.toMatchObject({
      code: 'SEARCH_INVALID_FIELD',
    })
    await expect(narsil.query('bikes', { term: 'bike', boost: { price: 5 } })).rejects.toMatchObject({
      code: 'SEARCH_INVALID_FIELD',
    })
  })

  it('raises CONFIG_INVALID for a boost that is no finite number', async () => {
    await expect(narsil.query('bikes', { term: 'bike', boost: { name: Number.NaN } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    })
  })

  it('raises SEARCH_INVALID_FIELD for a facet on a geopoint field', async () => {
    await expect(narsil.query('bikes', { term: 'bike', facets: { depot: {} } })).rejects.toMatchObject({
      code: 'SEARCH_INVALID_FIELD',
    })
  })

  it('counts the stored values of a facet field outside the schema', async () => {
    const result = await narsil.query('bikes', { term: 'bike', facets: { weight: {}, colour: {} } })
    expect(result.facets?.weight).toEqual({ values: { '12': 1, '14': 1 }, count: 2, errorBound: 0 })
    expect(result.facets?.colour).toEqual({ values: {}, count: 0, errorBound: 0 })
  })

  it('counts stored values of a field outside the schema into ranges', async () => {
    const result = await narsil.query('bikes', {
      term: 'bike',
      facets: { weight: { ranges: [{ from: 10, to: 13 }] } },
    })
    expect(result.facets?.weight.values).toEqual({ '10-13': 1 })
  })
})
