import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { indexConfig } from './fixtures'

describe('pinned documents under cursor pagination', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('products', indexConfig)
    await narsil.insert('products', { title: 'Headphones Alpha', category: 'a', price: 1 }, 'alpha')
    await narsil.insert('products', { title: 'Headphones Beta', category: 'b', price: 2 }, 'beta')
    await narsil.insert('products', { title: 'Headphones Gamma', category: 'c', price: 3 }, 'gamma')
    await narsil.insert('products', { title: 'Quiet Promo Item', category: 'd', price: 4 }, 'promo')
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('counts a pinned document that the query never matched, and counts a matching one once', async () => {
    const outside = await narsil.query('products', { term: 'headphones', pinned: [{ docId: 'promo', position: 0 }] })
    expect(outside.hits.map(hit => hit.id)).toContain('promo')
    expect(outside.count).toBe(4)
    expect(outside.countExact).toBe(true)

    const inside = await narsil.query('products', { term: 'headphones', pinned: [{ docId: 'beta', position: 0 }] })
    expect(inside.count).toBe(3)
  })

  it('places equal positions in request order and resolves repeated and missing pins before placement', async () => {
    await narsil.insert('products', { title: 'Quiet second promotion', category: 'e', price: 5 }, 'second')
    const answer = await narsil.query('products', {
      term: 'headphones',
      pinned: [
        { docId: 'beta', position: 0 },
        { docId: 'gamma', position: 0 },
        { docId: 'promo', position: 0 },
        { docId: 'second', position: 2 },
        { docId: 'beta', position: 3 },
        { docId: 'missing', position: 0 },
        { docId: 'alpha', position: Number.MAX_SAFE_INTEGER },
      ],
    })
    expect(answer.hits.map(hit => hit.id)).toEqual(['promo', 'gamma', 'second', 'beta', 'alpha'])
    expect(answer.hits.every(hit => hit.score === 0)).toBe(true)
    expect(answer.count).toBe(5)
    expect(answer.countExact).toBe(true)
    expect(answer.cursor).toBeUndefined()
  })

  it('appends distant placements in position order without narrowing the public position', async () => {
    const answer = await narsil.query('products', {
      term: 'headphones',
      pinned: [
        { docId: 'beta', position: Number.MAX_SAFE_INTEGER },
        { docId: 'promo', position: 2 ** 32 },
        { docId: 'alpha', position: 2 ** 32 + 1 },
      ],
    })
    expect(answer.hits.map(hit => hit.id)).toEqual(['gamma', 'promo', 'alpha', 'beta'])
    expect(answer.count).toBe(4)
  })

  it('anchors on a pinned-listed document that a cursor page returns organically', async () => {
    await narsil.insert('products', { title: 'Headphones Delta', category: 'e', price: 5 }, 'delta')
    const request = {
      term: 'headphones',
      pinned: [{ docId: 'beta', position: 0 }],
    }
    const firstPage = await narsil.query('products', { ...request, limit: 2 })
    expect(firstPage.hits.map(hit => hit.id)[0]).toBe('beta')

    const secondPage = await narsil.query('products', { ...request, limit: 1, searchAfter: firstPage.cursor })
    expect(secondPage.hits.map(hit => hit.id)).toEqual(['beta'])
    expect(secondPage.cursor).toBeDefined()

    const thirdPage = await narsil.query('products', { ...request, limit: 1, searchAfter: secondPage.cursor })
    expect(thirdPage.hits.length).toBe(1)
    expect(thirdPage.hits[0].id).not.toBe('beta')
  })

  it('continues past a page that ends on a pinned placement', async () => {
    const firstPage = await narsil.query('products', {
      term: 'headphones',
      pinned: [{ docId: 'promo', position: 1 }],
      limit: 2,
    })
    expect(firstPage.hits.map(hit => hit.id)[1]).toBe('promo')
    expect(firstPage.cursor).toBeDefined()

    const secondPage = await narsil.query('products', {
      term: 'headphones',
      pinned: [{ docId: 'promo', position: 1 }],
      limit: 2,
      searchAfter: firstPage.cursor,
    })
    expect(secondPage.hits.length).toBe(2)
    expect(secondPage.hits.map(hit => hit.id)).not.toContain('promo')
    expect(secondPage.hits.map(hit => hit.id)).not.toContain(firstPage.hits[0].id)
  })

  it('pins page one and leaves cursor pages to the organic ranking', async () => {
    const firstPage = await narsil.query('products', {
      term: 'headphones',
      pinned: [{ docId: 'promo', position: 0 }],
      limit: 2,
    })
    expect(firstPage.hits[0].id).toBe('promo')
    expect(firstPage.cursor).toBeDefined()

    const secondPage = await narsil.query('products', {
      term: 'headphones',
      pinned: [{ docId: 'promo', position: 0 }],
      limit: 2,
      searchAfter: firstPage.cursor,
    })
    const secondIds = secondPage.hits.map(hit => hit.id)
    expect(secondIds).not.toContain('promo')
    expect(secondIds).not.toContain(firstPage.hits[1].id)
    expect(secondIds.length).toBeGreaterThan(0)
  })
})
