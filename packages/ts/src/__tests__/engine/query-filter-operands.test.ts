import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { FilterExpression } from '../../types/filters'

describe('a filter whose operands cannot match the field', () => {
  let narsil: Narsil

  beforeAll(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('bikes', {
      schema: { name: 'string:pattern', price: 'number', category: 'enum', electric: 'boolean', depot: 'geopoint' },
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
    [
      'a radius centre north of the pole',
      { fields: { depot: { radius: { lat: 95, lon: 0, distance: 5, unit: 'km' } } } },
    ],
    [
      'a radius centre past the antimeridian',
      { fields: { depot: { radius: { lat: 0, lon: 180.5, distance: 5, unit: 'km' } } } },
    ],
    [
      'a polygon corner south of the pole',
      {
        fields: {
          depot: {
            polygon: {
              points: [
                { lat: 0, lon: 0 },
                { lat: -91, lon: 1 },
                { lat: 1, lon: 1 },
              ],
            },
          },
        },
      },
    ],
    [
      'a polygon corner past the antimeridian, nested under "not"',
      {
        not: {
          fields: {
            depot: {
              polygon: {
                points: [
                  { lat: 0, lon: 0 },
                  { lat: 1, lon: -200 },
                  { lat: 1, lon: 1 },
                ],
              },
            },
          },
        },
      },
    ],
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

  it('refuses a filter on a value stored in a field outside the schema, which no index holds', async () => {
    await expect(
      narsil.query('bikes', { term: 'bike', filters: { fields: { weight: { eq: 12 } } } }),
    ).rejects.toMatchObject({ code: 'SEARCH_INVALID_FIELD', details: { field: 'weight', option: 'filter' } })
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

  it('refuses a centre off the globe on an index that holds no documents yet', async () => {
    await narsil.createIndex('depots', { schema: { depot: 'geopoint' } })
    const filters: FilterExpression = { fields: { depot: { radius: { lat: 90.01, lon: 0, distance: 1, unit: 'km' } } } }
    await expect(narsil.query('depots', { filters })).rejects.toMatchObject({ code: 'SEARCH_INVALID_FILTER' })
    await expect(narsil.listDocuments('depots', { filters })).rejects.toMatchObject({ code: 'SEARCH_INVALID_FILTER' })
  })

  it('matches a circle centred on the edge of the globe', async () => {
    await narsil.insertBatch('bikes', [{ id: 'polar', name: 'Polar bike', depot: { lat: 90, lon: 180 } }])
    const page = await narsil.listDocuments('bikes', {
      filters: { fields: { depot: { radius: { lat: 90, lon: -180, distance: 1, unit: 'km' } } } },
    })
    expect(page.documents.map(document => document.id)).toEqual(['polar'])
    await narsil.remove('bikes', 'polar')
  })

  it('answers from the filter it checked when the operand changes on a later read', async () => {
    let reads = 0
    const price = {
      get gt(): unknown {
        reads++
        return reads <= 2 ? 1000 : 'every bike'
      },
    }
    const filters = { fields: { price } } as unknown as FilterExpression
    const result = await narsil.query('bikes', { term: 'bike', filters, limit: 10 })
    expect(result.hits.map(hit => hit.id)).toEqual(['trail'])
  })
})
