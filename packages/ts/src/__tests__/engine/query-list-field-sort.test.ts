import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { SchemaDefinition } from '../../types/schema'
import type { SortField } from '../../types/search'

const schema: SchemaDefinition = {
  title: 'string',
  prices: 'number[]',
  tags: 'string[]',
}

const products = [
  { id: 'lamp', title: 'desk lamp', prices: [30, 12], tags: ['office', 'light'] },
  { id: 'chair', title: 'desk chair', prices: [90, 45, 60], tags: ['office', 'seat'] },
  { id: 'mat', title: 'desk mat', prices: [18], tags: ['accessory'] },
  { id: 'shelf', title: 'desk shelf', prices: [], tags: [] },
  { id: 'tray', title: 'desk tray', prices: [5, 70], tags: ['office', 'storage'] },
]

describe('sorting on a field that holds a list', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('shop', { schema, language: 'english', partitions: { maxPartitions: 2 } })
    for (const { id, ...document } of products) {
      await narsil.insert('shop', document, id)
    }
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  async function idsFor(sort: SortField[], includeScores = false): Promise<string[]> {
    const result = await narsil.query('shop', { term: 'desk', sort, includeScores, limit: 10 })
    return result.hits.map(hit => hit.id)
  }

  it('sorts ascending by each list smallest value, with an empty list last', async () => {
    expect(await idsFor([{ field: 'prices', direction: 'asc' }])).toEqual(['tray', 'lamp', 'mat', 'chair', 'shelf'])
  })

  it('sorts descending by each list largest value, with an empty list last', async () => {
    expect(await idsFor([{ field: 'prices', direction: 'desc' }])).toEqual(['chair', 'tray', 'lamp', 'mat', 'shelf'])
  })

  it('sorts by the mean or the median of a number list where the query names that mode', async () => {
    expect(await idsFor([{ field: 'prices', direction: 'asc', mode: 'avg' }])).toEqual([
      'mat',
      'lamp',
      'tray',
      'chair',
      'shelf',
    ])
    expect(await idsFor([{ field: 'prices', direction: 'desc', mode: 'median' }])).toEqual([
      'chair',
      'tray',
      'lamp',
      'mat',
      'shelf',
    ])
  })

  it('orders the same way on the scored path as on the column path', async () => {
    const sort: SortField[] = [{ field: 'prices', direction: 'asc', mode: 'max' }]
    expect(await idsFor(sort, true)).toEqual(await idsFor(sort))
    expect(await idsFor(sort)).toEqual(['mat', 'lamp', 'tray', 'chair', 'shelf'])
  })

  it('sorts a list of strings by its first value in the sort order', async () => {
    expect(await idsFor([{ field: 'tags', direction: 'asc' }])).toEqual(['mat', 'lamp', 'chair', 'tray', 'shelf'])
  })

  it('pages a list sort with a cursor and refuses that cursor under another mode', async () => {
    const sort: SortField[] = [{ field: 'prices', direction: 'asc' }]
    const first = await narsil.query('shop', { term: 'desk', sort, limit: 2 })
    expect(first.hits.map(hit => hit.id)).toEqual(['tray', 'lamp'])

    const second = await narsil.query('shop', { term: 'desk', sort, limit: 2, searchAfter: first.cursor })
    expect(second.hits.map(hit => hit.id)).toEqual(['mat', 'chair'])

    await expect(
      narsil.query('shop', {
        term: 'desk',
        sort: [{ field: 'prices', direction: 'asc', mode: 'avg' }],
        limit: 2,
        searchAfter: first.cursor,
      }),
    ).rejects.toMatchObject({ code: 'SEARCH_INVALID_CURSOR' })
  })

  it('lists documents by a list field in the same order', async () => {
    const page = await narsil.listDocuments('shop', { sort: [{ field: 'prices', direction: 'desc' }], limit: 10 })
    expect(page.documents.map(document => document.id)).toEqual(['chair', 'tray', 'lamp', 'mat', 'shelf'])
  })

  it('refuses an average of a text list and a mode outside the four', async () => {
    await expect(
      narsil.query('shop', { term: 'desk', sort: [{ field: 'tags', direction: 'asc', mode: 'avg' }] }),
    ).rejects.toMatchObject({ code: 'SEARCH_INVALID_FIELD' })

    await expect(
      narsil.query('shop', {
        term: 'desk',
        sort: [{ field: 'prices', direction: 'asc', mode: 'sum' as SortField['mode'] }],
      }),
    ).rejects.toMatchObject({ code: 'SEARCH_INVALID_MODE' })
  })
})
