import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { SchemaDefinition } from '../../types/schema'

const schema: SchemaDefinition = {
  title: 'string',
  category: 'enum',
  rank: 'number',
}

const CATALOGUE_SIZE = 60

describe('a filtered listing', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('catalogue', { schema, language: 'english' })
    for (let index = 0; index < CATALOGUE_SIZE; index++) {
      await narsil.insert('catalogue', {
        id: `doc-${String(index).padStart(3, '0')}`,
        title: `entry ${index}`,
        category: index % 3 === 0 ? 'keep' : 'drop',
        rank: CATALOGUE_SIZE - index,
      })
    }
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('reports the exact number of matching documents', async () => {
    const page = await narsil.listDocuments('catalogue', {
      filters: { fields: { category: { eq: 'keep' } } },
      limit: 5,
    })
    expect(page.total).toBe(20)
  })

  it('walks every match exactly once across pages in id order', async () => {
    const seen: string[] = []
    let cursor: string | undefined

    for (;;) {
      const page = await narsil.listDocuments('catalogue', {
        filters: { fields: { category: { eq: 'keep' } } },
        limit: 7,
        cursor,
      })
      for (const document of page.documents) seen.push(document.id)
      if (page.cursor === null || page.cursor === undefined) break
      cursor = page.cursor
    }

    expect(seen).toHaveLength(20)
    expect(new Set(seen).size).toBe(20)
    expect([...seen].sort()).toEqual(seen)
    for (const id of seen) {
      const index = Number(id.slice('doc-'.length))
      expect(index % 3).toBe(0)
    }
  })

  it('walks every match exactly once across pages in sort order', async () => {
    const seen: string[] = []
    const ranks: number[] = []
    let cursor: string | undefined

    for (;;) {
      const page = await narsil.listDocuments('catalogue', {
        filters: { fields: { category: { eq: 'keep' } } },
        sort: { rank: 'asc' },
        limit: 6,
        cursor,
      })
      for (const document of page.documents) {
        seen.push(document.id)
        ranks.push((document.document as { rank: number }).rank)
      }
      if (page.cursor === null || page.cursor === undefined) break
      cursor = page.cursor
    }

    expect(seen).toHaveLength(20)
    expect(new Set(seen).size).toBe(20)
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
  })

  it('counts a filter that accepts nothing as zero', async () => {
    const page = await narsil.listDocuments('catalogue', {
      filters: { fields: { category: { eq: 'absent' } } },
      limit: 5,
    })
    expect(page.total).toBe(0)
    expect(page.documents).toHaveLength(0)
  })

  it('leaves a deleted document out of the total and the pages', async () => {
    await narsil.remove('catalogue', 'doc-000')

    const page = await narsil.listDocuments('catalogue', {
      filters: { fields: { category: { eq: 'keep' } } },
      limit: 50,
    })

    expect(page.total).toBe(19)
    expect(page.documents.map(document => document.id)).not.toContain('doc-000')
  })
})
