import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vectorFetchDepth } from '../../engine/query/vector'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import { RESULT_WINDOW } from '../../search/constants'
import type { SchemaDefinition } from '../../types/schema'

const DIMENSION = 4
const DOCUMENT_COUNT = 24

const schema: SchemaDefinition = {
  title: 'string',
  shelf: 'string',
  embedding: `vector[${DIMENSION}]`,
}

function unitVector(position: number): number[] {
  const angle = (position / DOCUMENT_COUNT) * Math.PI * 0.5
  return [Math.cos(angle), Math.sin(angle), 0, 0]
}

describe('a vector search reports what it matched and pages past the first page', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('catalogue', { schema, language: 'english' })
    for (let position = 0; position < DOCUMENT_COUNT; position++) {
      await narsil.insert('catalogue', {
        id: `doc${position}`,
        title: `widget ${position}`,
        shelf: position % 2 === 0 ? 'front' : 'back',
        embedding: unitVector(position),
      })
    }
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('counts every vector in the field whatever the page size, and marks the count exact', async () => {
    for (const limit of [1, 3, 10]) {
      const result = await narsil.query('catalogue', {
        vector: { field: 'embedding', value: unitVector(0) },
        limit,
      })
      expect(result.count).toBe(DOCUMENT_COUNT)
      expect(result.countExact).toBe(true)
      expect(result.hits).toHaveLength(limit)
    }
  })

  it('counts the documents a filter admits rather than the whole field', async () => {
    const result = await narsil.query('catalogue', {
      vector: { field: 'embedding', value: unitVector(0) },
      filters: { fields: { shelf: { eq: 'front' } } },
      limit: 2,
    })
    expect(result.count).toBe(DOCUMENT_COUNT / 2)
    expect(result.countExact).toBe(true)
  })

  it('counts every vector above a similarity floor while the field holds no graph', async () => {
    const floor = 0.9
    const all = await narsil.query('catalogue', {
      vector: { field: 'embedding', value: unitVector(0) },
      limit: DOCUMENT_COUNT,
    })
    const above = all.hits.filter(hit => (hit.score ?? 0) >= floor).length

    const result = await narsil.query('catalogue', {
      vector: { field: 'embedding', value: unitVector(0), similarity: floor },
      limit: 2,
    })
    expect(result.count).toBe(above)
    expect(result.countExact).toBe(true)
  })

  it('reaches every document through the cursor rather than stopping after one page', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0

    do {
      const result = await narsil.query('catalogue', {
        vector: { field: 'embedding', value: unitVector(0) },
        limit: 5,
        ...(cursor !== undefined ? { searchAfter: cursor } : {}),
      })
      for (const hit of result.hits) seen.push(hit.id)
      cursor = result.cursor
      pages++
    } while (cursor !== undefined && pages < DOCUMENT_COUNT)

    expect(seen).toHaveLength(DOCUMENT_COUNT)
    expect(new Set(seen).size).toBe(DOCUMENT_COUNT)
  })

  it('gives a hybrid search a full second page', async () => {
    const first = await narsil.query('catalogue', {
      term: 'widget',
      vector: { field: 'embedding', value: unitVector(0) },
      limit: 5,
    })
    expect(first.cursor).toBeDefined()

    const second = await narsil.query('catalogue', {
      term: 'widget',
      vector: { field: 'embedding', value: unitVector(0) },
      limit: 5,
      searchAfter: first.cursor,
    })

    expect(second.hits).toHaveLength(5)
    const firstIds = new Set(first.hits.map(hit => hit.id))
    for (const hit of second.hits) expect(firstIds.has(hit.id)).toBe(false)
  })

  it('refuses a vector page that reaches beyond the result window', async () => {
    const error = await narsil
      .query('catalogue', {
        vector: { field: 'embedding', value: unitVector(0) },
        limit: 10,
        offset: 9_995,
      })
      .catch((thrown: NarsilError) => thrown)

    expect((error as NarsilError).code).toBe(ErrorCodes.SEARCH_RESULT_WINDOW_EXCEEDED)
  })
})

describe('the depth a vector search fetches to', () => {
  it('covers the cursor, the offset, the page, and the probe for a page after it', () => {
    expect(vectorFetchDepth(10, 0, 0)).toBe(11)
    expect(vectorFetchDepth(10, 20, 0)).toBe(31)
    expect(vectorFetchDepth(10, 0, 250)).toBe(261)
    expect(vectorFetchDepth(10, 5, 250)).toBe(266)
  })

  it('fetches to the window rather than one past it at the last reachable page', () => {
    expect(vectorFetchDepth(10, 9_990, 0)).toBe(RESULT_WINDOW)
    expect(vectorFetchDepth(10, 0, 9_990)).toBe(RESULT_WINDOW)
  })

  it('refuses a page reaching past the window, whether by offset or by cursor', () => {
    expect(() => vectorFetchDepth(10, 9_991, 0)).toThrow(NarsilError)
    expect(() => vectorFetchDepth(10, 0, 9_991)).toThrow(NarsilError)
    try {
      vectorFetchDepth(10, 0, 9_991)
    } catch (thrown) {
      expect((thrown as NarsilError).code).toBe(ErrorCodes.SEARCH_RESULT_WINDOW_EXCEEDED)
    }
  })
})
