import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { indexConfig } from './fixtures'

const ids = ['a', 'b', 'c', '\ue000', '\u{10000}']

describe('cursor pages through the public search API', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('products', indexConfig)
    for (const id of [...ids].reverse()) {
      await narsil.insert('products', { title: 'Lamp', category: 'lighting', price: 1 }, id)
    }
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  for (const boost of [0, 1]) {
    it(`pages equal scores in code point ID order with a field boost of ${boost}`, async () => {
      const returned: string[] = []
      const scores: Array<number | undefined> = []
      let searchAfter: string | undefined
      for (let page = 0; page < ids.length; page++) {
        const answer = await narsil.query('products', { term: 'lamp', boost: { title: boost }, limit: 1, searchAfter })
        expect(answer.hits).toHaveLength(1)
        returned.push(answer.hits[0].id)
        scores.push(answer.hits[0].score)
        searchAfter = answer.cursor
        if (page < ids.length - 1) expect(searchAfter).toBeDefined()
      }
      expect(returned).toEqual(ids)
      expect(new Set(scores).size).toBe(1)
      if (boost === 0) expect(scores).toEqual(ids.map(() => 0))
      expect(searchAfter).toBeUndefined()
    })
  }

  it('pages sorted results with omitted scores and equal sort values', async () => {
    const first = await narsil.query('products', { term: 'lamp', sort: { price: 'asc' }, pinned: [], limit: 2 })
    expect(first.hits.map(hit => hit.id)).toEqual(ids.slice(0, 2))
    expect(first.hits.every(hit => hit.score === undefined)).toBe(true)
    expect(first.cursor).toBeDefined()
    const next = await narsil.query('products', {
      term: 'lamp',
      sort: { price: 'asc' },
      pinned: [],
      limit: 3,
      searchAfter: first.cursor,
    })
    expect(next.hits.map(hit => hit.id)).toEqual(ids.slice(2))
    expect(next.hits.every(hit => hit.score === undefined)).toBe(true)
    expect(next.cursor).toBeUndefined()
  })

  it('returns an empty page when every document after the anchor has left', async () => {
    const request = { term: 'lamp', boost: { title: 0 }, limit: 2 }
    const first = await narsil.query('products', request)
    expect(first.cursor).toBeDefined()
    for (const id of ids.slice(2)) await narsil.remove('products', id)
    const exhausted = await narsil.query('products', { ...request, searchAfter: first.cursor })
    expect(exhausted.hits).toEqual([])
    expect(exhausted.cursor).toBeUndefined()
    for (const id of ids.slice(0, 2)) await narsil.remove('products', id)
    const empty = await narsil.query('products', { ...request, searchAfter: first.cursor })
    expect(empty.hits).toEqual([])
    expect(empty.cursor).toBeUndefined()
  })

  it('rejects a cursor with its score removed before seeking', async () => {
    const first = await narsil.query('products', { term: 'lamp', limit: 2 })
    if (first.cursor === undefined) throw new Error('the first page has no cursor')
    const cursor = JSON.parse(Buffer.from(first.cursor, 'base64').toString()) as Record<string, unknown>
    delete cursor.s
    const searchAfter = Buffer.from(JSON.stringify(cursor)).toString('base64')
    await expect(narsil.query('products', { term: 'lamp', limit: 2, searchAfter })).rejects.toMatchObject({
      code: 'SEARCH_INVALID_CURSOR',
    })
  })

  it('keeps vector page bindings across zero, subnormal, and rounded coordinates', async () => {
    await narsil.createIndex('directions', { schema: { embedding: 'vector[2]' } })
    await narsil.insert('directions', { embedding: [1, 0] }, 'east')
    await narsil.insert('directions', { embedding: [0, 1] }, 'north')
    const cases: Array<{ value: number[]; binding: string }> = [
      { value: [0, 0], binding: 'd0eaa593' },
      { value: [-0, 0], binding: '8883db13' },
      { value: [2 ** -149, -(2 ** -149)], binding: '30472d3f' },
      { value: [1 + 2 ** -24, 1 + 2 ** -23], binding: '0830dc35' },
      { value: [0.1, -0.1], binding: '45a65fbf' },
      { value: [2 ** 64, -(2 ** 64)], binding: '4615da0d' },
    ]
    for (const { value, binding } of cases) {
      const params = { vector: { field: 'embedding', value }, limit: 1 }
      const first = await narsil.query('directions', params)
      if (first.cursor === undefined) throw new Error('The vector page has no cursor')
      const cursor = JSON.parse(Buffer.from(first.cursor, 'base64').toString()) as Record<string, unknown>
      expect(cursor.q).toBe(binding)
      cursor.q = binding
      const searchAfter = Buffer.from(JSON.stringify(cursor)).toString('base64')
      const second = await narsil.query('directions', { ...params, searchAfter })
      expect([...first.hits, ...second.hits].map(hit => hit.id).sort()).toEqual(['east', 'north'])
      expect(second.cursor).toBeUndefined()
      await expect(
        narsil.query('directions', { vector: { field: 'embedding', value: [2, 3] }, limit: 1, searchAfter }),
      ).rejects.toMatchObject({ code: 'SEARCH_INVALID_CURSOR' })
    }
  })
})
