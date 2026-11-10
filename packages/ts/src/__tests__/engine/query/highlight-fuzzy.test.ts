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

  it('marks the original Unicode words and keeps a surrogate pair whole at the snippet edge', async () => {
    await narsil.createIndex('unicode', { schema: { name: 'string' }, language: 'english' })
    const words = ['Cafe\u0301', 'ＲＵＮＮＩＮＧ', 'İSTANBUL', 'generosity']
    const text = `😀 ${words.join(' ')}`
    await narsil.insert('unicode', { name: text }, 'words')
    const result = await narsil.query('unicode', {
      term: 'café running istanbul generosity',
      highlight: { fields: ['name'] },
    })
    expect(result.hits[0]?.highlights?.name).toEqual({
      snippet: `😀 ${words.map(word => `<mark>${word}</mark>`).join(' ')}`,
      positions: words.map(word => ({ start: text.indexOf(word), end: text.indexOf(word) + word.length })),
    })
    const clipped = await narsil.query('unicode', {
      term: 'running',
      highlight: { fields: ['name'], maxSnippetLength: 1 },
    })
    expect(clipped.hits[0]?.highlights?.name).toEqual({ snippet: '😀...', positions: [] })
  })
})
