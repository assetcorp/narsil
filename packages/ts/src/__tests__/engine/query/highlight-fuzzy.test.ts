import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'

describe('highlighting the words that a typo-tolerant query matches', () => {
  let narsil: Narsil

  beforeAll(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('bikes', { schema: { name: 'string' }, language: 'english' })
    await narsil.insert('bikes', { name: 'Ferreira Urban commuter' }, 'urban')
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  it('marks the word that a query within its tolerance matches', async () => {
    const result = await narsil.query('bikes', {
      term: 'comuter',
      tolerance: 1,
      highlight: { fields: ['name'] },
    })

    expect(result.hits.map(hit => hit.id)).toEqual(['urban'])
    expect(result.hits[0]?.highlights?.name?.snippet).toBe('Ferreira Urban <mark>commuter</mark>')
  })

  it('marks a prefix completion and an exact word the same way', async () => {
    const prefixed = await narsil.query('bikes', { term: 'comm', prefix: true, highlight: { fields: ['name'] } })
    const exact = await narsil.query('bikes', { term: 'commuter', highlight: { fields: ['name'] } })

    expect(prefixed.hits[0]?.highlights?.name?.snippet).toBe('Ferreira Urban <mark>commuter</mark>')
    expect(exact.hits[0]?.highlights?.name?.snippet).toBe('Ferreira Urban <mark>commuter</mark>')
  })

  it('marks nothing beyond the tolerance', async () => {
    const result = await narsil.query('bikes', {
      term: 'urban cmtr',
      tolerance: 1,
      highlight: { fields: ['name'] },
    })

    expect(result.hits[0]?.highlights?.name?.snippet).toBe('Ferreira <mark>Urban</mark> commuter')
  })
})
