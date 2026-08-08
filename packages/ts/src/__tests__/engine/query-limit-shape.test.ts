import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { SchemaDefinition } from '../../types/schema'

const schema: SchemaDefinition = {
  title: 'string',
  rank: 'number',
}

const documents = [
  { id: 'a', title: 'widget alpha', rank: 1 },
  { id: 'b', title: 'widget beta', rank: 2 },
  { id: 'c', title: 'widget gamma', rank: 3 },
  { id: 'd', title: 'widget delta', rank: 4 },
  { id: 'e', title: 'widget epsilon', rank: 5 },
]

describe('a query limit that is not a whole number', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('catalogue', { schema, language: 'english' })
    for (const document of documents) {
      await narsil.insert('catalogue', document)
    }
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('answers a NaN limit with the default page rather than crashing', async () => {
    const result = await narsil.query('catalogue', { term: 'widget', limit: Number.NaN })
    expect(result.hits).toHaveLength(documents.length)
  })

  it('answers an infinite limit with the default page', async () => {
    const result = await narsil.query('catalogue', { term: 'widget', limit: Number.POSITIVE_INFINITY })
    expect(result.hits).toHaveLength(documents.length)
  })

  it('rounds a fractional limit down and returns the highest-scoring hits', async () => {
    const fractional = await narsil.query('catalogue', { term: 'widget', limit: 2.9 })
    const whole = await narsil.query('catalogue', { term: 'widget', limit: 2 })

    expect(fractional.hits).toHaveLength(2)
    expect(fractional.hits.map(hit => hit.id)).toEqual(whole.hits.map(hit => hit.id))
  })

  it('treats a negative limit as zero', async () => {
    const result = await narsil.query('catalogue', { term: 'widget', limit: -1 })
    expect(result.hits).toHaveLength(0)
  })

  it('rounds a fractional offset down', async () => {
    const fractional = await narsil.query('catalogue', { term: 'widget', limit: 2, offset: 1.9 })
    const whole = await narsil.query('catalogue', { term: 'widget', limit: 2, offset: 1 })

    expect(fractional.hits.map(hit => hit.id)).toEqual(whole.hits.map(hit => hit.id))
  })

  it('scores a fractional limit the same way a whole limit does', async () => {
    const wide = await narsil.query('catalogue', { term: 'widget', limit: 5 })
    const fractional = await narsil.query('catalogue', { term: 'widget', limit: 3.5 })

    expect(fractional.hits.map(hit => hit.id)).toEqual(wide.hits.slice(0, 3).map(hit => hit.id))
  })

  it('still accepts a whole-number limit and offset', async () => {
    const result = await narsil.query('catalogue', { term: 'widget', limit: 2, offset: 1 })
    expect(result.hits).toHaveLength(2)
  })
})

describe('a malformed cursor', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('catalogue', { schema, language: 'english' })
    for (const document of documents) {
      await narsil.insert('catalogue', document)
    }
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('is refused even when the limit leaves no room for a page', async () => {
    await expect(
      narsil.query('catalogue', { term: 'widget', limit: 0, searchAfter: 'not-a-cursor' }),
    ).rejects.toMatchObject({ code: 'SEARCH_INVALID_CURSOR' })
  })

  it('is refused on a normal page as well', async () => {
    await expect(
      narsil.query('catalogue', { term: 'widget', limit: 2, searchAfter: 'not-a-cursor' }),
    ).rejects.toMatchObject({ code: 'SEARCH_INVALID_CURSOR' })
  })
})
