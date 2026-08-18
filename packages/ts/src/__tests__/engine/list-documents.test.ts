import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { ListResult } from '../../types/results'
import type { SchemaDefinition } from '../../types/schema'

const schema: SchemaDefinition = {
  title: 'string',
  rank: 'number',
}

async function seed(narsil: Narsil, indexName: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    await narsil.insert(indexName, { title: `document ${ids[i]}`, rank: i }, ids[i])
  }
}

async function listAll(narsil: Narsil, indexName: string, limit: number): Promise<string[]> {
  const seen: string[] = []
  let cursor: string | undefined
  for (;;) {
    const page: ListResult = await narsil.listDocuments(indexName, { limit, cursor })
    for (const entry of page.documents) seen.push(entry.id)
    if (page.cursor === null) return seen
    cursor = page.cursor
  }
}

describe('listDocuments', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('returns every document once, in document-id order, across pages', async () => {
    await narsil.createIndex('docs', { schema, language: 'english' })
    await seed(narsil, 'docs', ['b', 'a', 'd', 'c', 'e'])

    const seen = await listAll(narsil, 'docs', 2)

    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('orders ids by their code units, so "10" sorts ahead of "9"', async () => {
    await narsil.createIndex('docs', { schema, language: 'english' })
    await seed(narsil, 'docs', ['9', '10', '1'])

    const seen = await listAll(narsil, 'docs', 10)

    expect(seen).toEqual(['1', '10', '9'])
  })

  it('reports the total and closes the listing with a null cursor', async () => {
    await narsil.createIndex('docs', { schema, language: 'english' })
    await seed(narsil, 'docs', ['a', 'b', 'c'])

    const first = await narsil.listDocuments('docs', { limit: 2 })
    expect(first.total).toBe(3)
    expect(first.cursor).not.toBeNull()

    const second = await narsil.listDocuments('docs', { limit: 2, cursor: first.cursor ?? undefined })
    expect(second.documents.map(entry => entry.id)).toEqual(['c'])
    expect(second.cursor).toBeNull()
  })

  it('merges partitions into one global order', async () => {
    await narsil.createIndex('docs', { schema, language: 'english', partitions: { maxPartitions: 4 } })
    await seed(narsil, 'docs', ['e', 'c', 'a', 'd', 'b', 'f'])

    expect(narsil.getStats('docs').partitionCount).toBe(4)
    expect(await listAll(narsil, 'docs', 2)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('keeps a cursor valid across a snapshot restored into another engine', async () => {
    await narsil.createIndex('docs', { schema, language: 'english' })
    await seed(narsil, 'docs', ['a', 'b', 'c', 'd'])

    const first = await narsil.listDocuments('docs', { limit: 2 })
    expect(first.documents.map(entry => entry.id)).toEqual(['a', 'b'])

    const bytes = await narsil.snapshot('docs')
    const restored = await createNarsil()
    try {
      await restored.restore('docs', bytes)
      const second = await restored.listDocuments('docs', { limit: 2, cursor: first.cursor ?? undefined })
      expect(second.documents.map(entry => entry.id)).toEqual(['c', 'd'])
      expect(second.cursor).toBeNull()
    } finally {
      await restored.shutdown()
    }
  })

  it('keeps a cursor valid across a rebalance', async () => {
    await narsil.createIndex('docs', { schema, language: 'english', partitions: { maxPartitions: 4 } })
    await seed(narsil, 'docs', ['a', 'b', 'c', 'd', 'e', 'f'])

    const first = await narsil.listDocuments('docs', { limit: 2 })
    expect(first.documents.map(entry => entry.id)).toEqual(['a', 'b'])

    await narsil.rebalance('docs', 2)

    const rest = await narsil.listDocuments('docs', { limit: 10, cursor: first.cursor ?? undefined })
    expect(rest.documents.map(entry => entry.id)).toEqual(['c', 'd', 'e', 'f'])
  })

  it('returns a document updated part-way through only once', async () => {
    await narsil.createIndex('docs', { schema, language: 'english' })
    await seed(narsil, 'docs', ['a', 'b', 'c', 'd'])

    const first = await narsil.listDocuments('docs', { limit: 2 })
    await narsil.update('docs', 'a', { title: 'rewritten body text', rank: 99 })

    const rest = await narsil.listDocuments('docs', { limit: 10, cursor: first.cursor ?? undefined })

    expect(rest.documents.map(entry => entry.id)).toEqual(['c', 'd'])
  })

  it('skips a document removed part-way through and returns one inserted above the cursor', async () => {
    await narsil.createIndex('docs', { schema, language: 'english' })
    await seed(narsil, 'docs', ['a', 'b', 'c', 'd'])

    const first = await narsil.listDocuments('docs', { limit: 2 })
    await narsil.remove('docs', 'd')
    await narsil.insert('docs', { title: 'below the cursor', rank: 0 }, 'aa')
    await narsil.insert('docs', { title: 'above the cursor', rank: 0 }, 'z')

    const rest = await narsil.listDocuments('docs', { limit: 10, cursor: first.cursor ?? undefined })

    expect(rest.documents.map(entry => entry.id)).toEqual(['c', 'z'])
  })

  it('narrows the listing to the documents a filter accepts', async () => {
    await narsil.createIndex('docs', { schema, language: 'english' })
    await seed(narsil, 'docs', ['a', 'b', 'c', 'd', 'e'])

    const seen: string[] = []
    let cursor: string | undefined
    let total = 0
    for (;;) {
      const page = await narsil.listDocuments('docs', { limit: 1, cursor, filters: { fields: { rank: { gte: 2 } } } })
      total = page.total
      for (const entry of page.documents) seen.push(entry.id)
      if (page.cursor === null) break
      cursor = page.cursor
    }

    expect(seen).toEqual(['c', 'd', 'e'])
    expect(total).toBe(3)
  })

  it('cuts each document down to the projection', async () => {
    await narsil.createIndex('docs', { schema, language: 'english' })
    await seed(narsil, 'docs', ['a'])

    const page = await narsil.listDocuments('docs', { document: { include: ['rank'] } })

    expect(page.documents[0].document).toEqual({ rank: 0 })
  })

  it('rejects a cursor it did not issue', async () => {
    await narsil.createIndex('docs', { schema, language: 'english' })
    await seed(narsil, 'docs', ['a'])

    await expect(narsil.listDocuments('docs', { cursor: 'not-a-cursor' })).rejects.toThrow(NarsilError)
    await expect(narsil.listDocuments('docs', { cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_CURSOR,
    })
  })

  it('lists an empty index without a cursor', async () => {
    await narsil.createIndex('docs', { schema, language: 'english' })

    const page = await narsil.listDocuments('docs')

    expect(page.documents).toEqual([])
    expect(page.cursor).toBeNull()
    expect(page.total).toBe(0)
  })
})
