import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { FilterExpression } from '../../types/filters'

describe('a filter whose operands cannot match the field', () => {
  let narsil: Narsil

  beforeAll(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('bikes', {
      schema: { name: 'string', price: 'number', category: 'enum', electric: 'boolean', depot: 'geopoint' },
    })
    await narsil.insertBatch('bikes', [
      {
        id: 'urban',
        name: 'Urban commuter bike',
        price: 700,
        category: 'city',
        electric: false,
        depot: { lat: 51.5, lon: -0.1 },
      },
      { id: 'trail', name: 'Trail bike', price: 1400, category: 'mountain', electric: true, weight: 12 },
    ])
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  const refused: Array<[string, FilterExpression]> = [
    ['a text operator on a number field', { fields: { price: { startsWith: '7' } } }],
    ['a range on an enum field', { fields: { category: { gt: 3 } } }],
    ['"between" with one bound', { fields: { price: { between: [700] as unknown as [number, number] } } }],
    [
      '"between" with a bound that is no number',
      { fields: { price: { between: [700, 'x'] as unknown as [number, number] } } },
    ],
    ['a negative radius', { fields: { depot: { radius: { lat: 51.5, lon: -0.1, distance: -5, unit: 'km' } } } }],
    ['a string compared with a number field', { fields: { price: { eq: '700' } } }],
    ['a number compared with a boolean field', { fields: { electric: { eq: 1 } } }],
    ['"in" on a number field', { fields: { price: { in: ['700'] } } }],
    ['a nested refusal under "or"', { or: [{ fields: { price: { startsWith: '7' } } }] }],
  ]

  it.each(refused)('raises SEARCH_INVALID_FILTER for %s', async (_, filters) => {
    await expect(narsil.query('bikes', { filters })).rejects.toMatchObject({ code: 'SEARCH_INVALID_FILTER' })
    await expect(narsil.query('bikes', { term: 'bike', filters })).rejects.toMatchObject({
      code: 'SEARCH_INVALID_FILTER',
    })
    await expect(narsil.preflight('bikes', { term: 'bike', filters })).rejects.toMatchObject({
      code: 'SEARCH_INVALID_FILTER',
    })
    await expect(narsil.listDocuments('bikes', { filters })).rejects.toMatchObject({ code: 'SEARCH_INVALID_FILTER' })
  })

  it('still filters by a value stored in a field outside the schema', async () => {
    const result = await narsil.query('bikes', { term: 'bike', filters: { fields: { weight: { eq: 12 } } } })
    expect(result.hits.map(hit => hit.id)).toEqual(['trail'])
  })

  it('still matches a radius of zero and well-formed operators', async () => {
    const result = await narsil.query('bikes', {
      term: 'bike',
      filters: {
        fields: {
          price: { between: [500, 900] },
          category: { in: ['city'] },
          name: { startsWith: 'Urban' },
          depot: { radius: { lat: 51.5, lon: -0.1, distance: 0, unit: 'km' } },
        },
      },
    })
    expect(result.hits.map(hit => hit.id)).toEqual(['urban'])
  })
})
