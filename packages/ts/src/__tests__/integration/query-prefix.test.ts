import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { IndexConfig } from '../../types/schema'

const indexConfig: IndexConfig = {
  schema: { title: 'string', body: 'string' },
  language: 'english',
}

const documents = [
  { id: 'sec-1', title: 'Security guidelines', body: 'How we handle platform security reviews' },
  { id: 'sec-2', title: 'Secure deployment checklist', body: 'Steps for a secure production rollout' },
  { id: 'db-1', title: 'Database migrations', body: 'Running schema migrations safely' },
  { id: 'ui-1', title: 'Component library', body: 'Buttons, dialogs, and layout primitives' },
]

describe('query with last-token prefix matching', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('docs', indexConfig)
    await narsil.insertBatch('docs', documents)
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('matches unfinished words only when prefix is enabled', async () => {
    const withoutPrefix = await narsil.query('docs', { term: 'sec' })
    expect(withoutPrefix.hits).toHaveLength(0)

    const withPrefix = await narsil.query('docs', { term: 'sec', prefix: true })
    const ids = withPrefix.hits.map(h => h.id).sort()
    expect(ids).toEqual(['sec-1', 'sec-2'])
  })

  it('matches when the typed prefix overshoots the indexed stem', async () => {
    const withoutPrefix = await narsil.query('docs', { term: 'securi' })
    expect(withoutPrefix.hits).toHaveLength(0)

    const withPrefix = await narsil.query('docs', { term: 'securi', prefix: true })
    expect(withPrefix.hits.map(h => h.id).sort()).toEqual(['sec-1', 'sec-2'])
  })

  it('requires earlier words to match fully', async () => {
    const result = await narsil.query('docs', { term: 'platform secur', prefix: true, termMatch: 'all' })
    expect(result.hits.map(h => h.id)).toEqual(['sec-1'])

    const incompleteEarlier = await narsil.query('docs', { term: 'platfo security', prefix: true, termMatch: 'all' })
    expect(incompleteEarlier.hits).toHaveLength(0)
  })

  it('combines typo tolerance on complete words with the prefix token', async () => {
    const result = await narsil.query('docs', {
      term: 'platforn secur',
      prefix: true,
      tolerance: 1,
      termMatch: 'all',
    })
    expect(result.hits.map(h => h.id)).toEqual(['sec-1'])
  })

  it('highlights the completed word of the prefix token', async () => {
    const result = await narsil.query('docs', {
      term: 'secur',
      prefix: true,
      highlight: { fields: ['title'] },
    })
    const hit = result.hits.find(h => h.id === 'sec-1')
    expect(hit?.highlights?.title?.snippet).toContain('<mark>Security</mark>')
  })

  it('reports the matched documents in count', async () => {
    const result = await narsil.query('docs', { term: 'migrat', prefix: true })
    expect(result.count).toBe(1)
    expect(result.hits[0].id).toBe('db-1')
  })
})
