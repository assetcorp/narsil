import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import type { SchemaDefinition } from '../../../types/schema'

const schema: SchemaDefinition = { title: 'string', body: 'string' }

const WORKERS_OFF = { workers: { enabled: false } } as const

describe('highlighting a field the projection dropped', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil(WORKERS_OFF)
    await narsil.createIndex('docs', { schema, language: 'english' })
    await narsil.insert('docs', { title: 'wireless headphones', body: 'the sound is wireless and clear' })
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('still reports the highlight', async () => {
    const result = await narsil.query('docs', {
      term: 'wireless',
      highlight: { fields: ['title'] },
      document: { include: ['body'] },
    })

    expect(result.hits[0]?.highlights?.title?.snippet).toContain('<mark>wireless</mark>')
  })

  it('reports positions that index the original field once the snippet is cut', async () => {
    const lead = 'a'.repeat(300)
    await narsil.insert('docs', { title: 'long', body: `${lead} wireless tail` }, 'long-body')

    const result = await narsil.query('docs', {
      term: 'wireless',
      highlight: { fields: ['body'], maxSnippetLength: 60 },
    })

    const hit = result.hits.find(entry => entry.id === 'long-body')
    const match = hit?.highlights?.body
    expect(match?.snippet).toContain('<mark>wireless</mark>')
    expect(match?.positions[0]?.start).toBe(lead.length + 1)
  })
})
