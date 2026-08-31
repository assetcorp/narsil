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
