import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { ListResult } from '../../types/results'
import type { SchemaDefinition } from '../../types/schema'

const schema: SchemaDefinition = {
  title: 'string:sortable',
  rank: 'number',
  genre: 'enum',
}

interface Seed {
  id: string
  title: string
  rank: number
  genre: string
}

const catalogue: Seed[] = [
  { id: 'd1', title: 'delta', rank: 30, genre: 'drama' },
  { id: 'd2', title: 'alpha', rank: 10, genre: 'comedy' },
  { id: 'd3', title: 'charlie', rank: 20, genre: 'drama' },
  { id: 'd4', title: 'bravo', rank: 40, genre: 'comedy' },
  { id: 'd5', title: 'echo', rank: 20, genre: 'drama' },
]

async function seed(narsil: Narsil, indexName: string, documents: Seed[]): Promise<void> {
  for (const entry of documents) {
    await narsil.insert(indexName, { title: entry.title, rank: entry.rank, genre: entry.genre }, entry.id)
  }
}

async function pageThrough(
  narsil: Narsil,
  indexName: string,
  sort: Record<string, 'asc' | 'desc'>,
  limit: number,
): Promise<string[]> {
  const seen: string[] = []
  let cursor: string | undefined
  for (;;) {
    const page: ListResult = await narsil.listDocuments(indexName, { limit, cursor, sort })
    for (const entry of page.documents) seen.push(entry.id)
    if (page.cursor === null) return seen
    cursor = page.cursor
  }
}

describe('listDocuments with a sort', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('docs', { schema, language: 'english' })
    await seed(narsil, 'docs', catalogue)
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('orders the whole index by a number field, not only the first page', async () => {
    const seen = await pageThrough(narsil, 'docs', { rank: 'desc' }, 2)

    expect(seen).toEqual(['d4', 'd1', 'd3', 'd5', 'd2'])
  })

  it('orders by a string field', async () => {
    const seen = await pageThrough(narsil, 'docs', { title: 'asc' }, 10)

    expect(seen).toEqual(['d2', 'd4', 'd3', 'd1', 'd5'])
  })

  it('settles a tie by document id', async () => {
    const page = await narsil.listDocuments('docs', { sort: { rank: 'asc' }, limit: 10 })

    expect(page.documents.map(entry => entry.id)).toEqual(['d2', 'd3', 'd5', 'd1', 'd4'])
  })

  it('sorts what the filter accepts and counts only those documents', async () => {
    const page = await narsil.listDocuments('docs', {
      sort: { rank: 'desc' },
      filters: { fields: { genre: { eq: 'drama' } } },
      limit: 10,
    })

    expect(page.documents.map(entry => entry.id)).toEqual(['d1', 'd3', 'd5'])
    expect(page.total).toBe(3)
  })

  it('pages a filtered listing without repeating a document', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await narsil.listDocuments('docs', {
        sort: { rank: 'desc' },
        filters: { fields: { genre: { eq: 'drama' } } },
        limit: 1,
        cursor,
      })
      for (const entry of page.documents) seen.push(entry.id)
      if (page.cursor === null) break
      cursor = page.cursor
    }

    expect(seen).toEqual(['d1', 'd3', 'd5'])
  })

  it('sorts a document missing the field to the end', async () => {
    await narsil.insert('docs', { title: 'foxtrot', genre: 'drama' }, 'd6')

    const page = await narsil.listDocuments('docs', { sort: { rank: 'asc' }, limit: 10 })

    expect(page.documents[page.documents.length - 1].id).toBe('d6')
  })

  it('rejects a cursor the caller replays under a different sort', async () => {
    const first = await narsil.listDocuments('docs', { sort: { rank: 'desc' }, limit: 2 })
    expect(first.cursor).not.toBeNull()

    await expect(
      narsil.listDocuments('docs', { sort: { title: 'asc' }, limit: 2, cursor: first.cursor ?? undefined }),
    ).rejects.toThrow(NarsilError)
  })

  it('rejects a sorted cursor the caller replays without a sort', async () => {
    const first = await narsil.listDocuments('docs', { sort: { rank: 'desc' }, limit: 2 })

    await expect(narsil.listDocuments('docs', { limit: 2, cursor: first.cursor ?? undefined })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_CURSOR,
    })
  })

  it('rejects an unsorted cursor the caller replays with a sort', async () => {
    const first = await narsil.listDocuments('docs', { limit: 2 })

    await expect(
      narsil.listDocuments('docs', { sort: { rank: 'desc' }, limit: 2, cursor: first.cursor ?? undefined }),
    ).rejects.toMatchObject({ code: ErrorCodes.SEARCH_INVALID_CURSOR })
  })

  it('carries on from the cursor after the anchor document is removed', async () => {
    const first = await narsil.listDocuments('docs', { sort: { rank: 'desc' }, limit: 2 })
    expect(first.documents.map(entry => entry.id)).toEqual(['d4', 'd1'])

    await narsil.remove('docs', 'd1')

    const second = await narsil.listDocuments('docs', {
      sort: { rank: 'desc' },
      limit: 10,
      cursor: first.cursor ?? undefined,
    })

    expect(second.documents.map(entry => entry.id)).toEqual(['d3', 'd5', 'd2'])
  })

  it('reads document-id order when the sort names no field', async () => {
    const page = await narsil.listDocuments('docs', { sort: {}, limit: 10 })

    expect(page.documents.map(entry => entry.id)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5'])
  })

  it('refuses a sort naming more fields than a cursor can carry', async () => {
    const sort: Record<string, 'asc'> = {}
    for (let i = 0; i < 9; i++) sort[`field${i}`] = 'asc'

    await expect(narsil.listDocuments('docs', { sort, limit: 10 })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_FIELD,
    })
  })

  it('refuses a cursor carrying a sort key with no sort order beside it', async () => {
    const forged = Buffer.from(JSON.stringify({ v: 1, a: 'd1', k: [10] })).toString('base64url')

    await expect(narsil.listDocuments('docs', { sort: { rank: 'desc' }, cursor: forged })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_CURSOR,
    })
  })
})

describe('listDocuments paging a sorted index', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('wide', { schema, language: 'english' })
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('walks every document once, in order, when many documents share a sort value', async () => {
    const documents: Seed[] = []
    for (let i = 0; i < 200; i++) {
      documents.push({
        id: `w${String(i).padStart(3, '0')}`,
        title: `title ${i % 5}`,
        rank: i % 7,
        genre: 'drama',
      })
    }
    await seed(narsil, 'wide', documents)

    const seen = await pageThrough(narsil, 'wide', { rank: 'desc' }, 7)

    const expected = documents
      .slice()
      .sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : 1))
      .map(entry => entry.id)

    expect(seen).toEqual(expected)
    expect(new Set(seen).size).toBe(documents.length)
  })
})
