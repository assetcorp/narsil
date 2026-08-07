import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { ListResult } from '../../types/results'
import type { IndexConfig } from '../../types/schema'

const CORPUS_SIZE = 25_000
const PAGE_SIZE = 500

interface Catalogue {
  id: string
  label: string
  blurb: string
  rank: number
  genre: string
  stocked: boolean
}

const GENRES = ['comedy', 'drama', 'history', 'romance', 'thriller']

function idOf(index: number): string {
  return `doc-${String(index).padStart(6, '0')}`
}

function labelOf(index: number): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const first = letters[index % 26]
  const second = letters[(index * 7) % 26]
  const third = letters[(index * 13) % 26]
  return `${first}${second}${third}-${String((index * 37) % 9973).padStart(4, '0')}`
}

function buildCatalogue(size: number, offset = 0): Catalogue[] {
  const documents: Catalogue[] = []
  for (let index = offset; index < offset + size; index++) {
    documents.push({
      id: idOf(index),
      label: labelOf(index),
      blurb: 'catalogue entry',
      rank: (index * 2654435761) % 100_000,
      genre: GENRES[index % GENRES.length],
      stocked: index % 3 === 0,
    })
  }
  return documents
}

function referenceOrder(
  documents: Catalogue[],
  reader: (entry: Catalogue) => Array<string | number | boolean | undefined>,
  directions: Array<'asc' | 'desc'>,
): string[] {
  const ranked = documents.slice()
  ranked.sort((left, right) => {
    const leftValues = reader(left)
    const rightValues = reader(right)
    for (let i = 0; i < directions.length; i++) {
      const a = leftValues[i]
      const b = rightValues[i]
      if (a === undefined && b === undefined) continue
      if (a === undefined) return 1
      if (b === undefined) return -1
      let comparison = 0
      if (typeof a === 'number' && typeof b === 'number') comparison = a - b
      else if (typeof a === 'boolean' && typeof b === 'boolean') comparison = a === b ? 0 : a ? 1 : -1
      else comparison = String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
      if (comparison !== 0) return directions[i] === 'desc' ? -comparison : comparison
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  return ranked.map(entry => entry.id)
}

async function walkEveryPage(
  narsil: Narsil,
  indexName: string,
  sort: Record<string, 'asc' | 'desc'>,
  limit: number,
  filters?: Record<string, unknown>,
): Promise<{ ids: string[]; totals: number[] }> {
  const ids: string[] = []
  const totals: number[] = []
  let cursor: string | undefined
  for (;;) {
    const page: ListResult = await narsil.listDocuments(indexName, {
      limit,
      cursor,
      sort,
      ...(filters === undefined ? {} : { filters }),
    })
    totals.push(page.total)
    for (const entry of page.documents) ids.push(entry.id)
    if (page.cursor === null) return { ids, totals }
    cursor = page.cursor
  }
}

const config: IndexConfig = {
  schema: {
    label: 'string:sortable',
    blurb: 'string',
    rank: 'number',
    genre: 'enum',
    stocked: 'boolean',
  },
  language: 'english',
}

describe('sorted paging off the sort columns', () => {
  let narsil: Narsil
  const catalogue = buildCatalogue(CORPUS_SIZE)

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('catalogue', config)
    await narsil.insertBatch(
      'catalogue',
      catalogue.map(entry => ({ ...entry })),
    )
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('walks every document once under a number sort, in the reference order', async () => {
    const expected = referenceOrder(catalogue, entry => [entry.rank], ['desc'])

    const { ids, totals } = await walkEveryPage(narsil, 'catalogue', { rank: 'desc' }, PAGE_SIZE)

    expect(ids).toEqual(expected)
    expect(new Set(ids).size).toBe(CORPUS_SIZE)
    expect(new Set(totals)).toEqual(new Set([CORPUS_SIZE]))
  })

  it('walks every document once under a text sort the schema marks sortable', async () => {
    const expected = referenceOrder(catalogue, entry => [entry.label], ['asc'])

    const { ids } = await walkEveryPage(narsil, 'catalogue', { label: 'asc' }, PAGE_SIZE)

    expect(ids).toEqual(expected)
  })

  it('walks every document once under a sort naming three fields', async () => {
    const expected = referenceOrder(catalogue, entry => [entry.genre, entry.stocked, entry.rank], [
      'asc',
      'desc',
      'asc',
    ])

    const { ids } = await walkEveryPage(narsil, 'catalogue', { genre: 'asc', stocked: 'desc', rank: 'asc' }, PAGE_SIZE)

    expect(ids).toEqual(expected)
  })

  it('sorts what a filter accepts and counts only those documents', async () => {
    const accepted = catalogue.filter(entry => entry.genre === 'drama' && entry.rank >= 50_000)
    const expected = referenceOrder(accepted, entry => [entry.rank], ['asc'])

    const { ids, totals } = await walkEveryPage(narsil, 'catalogue', { rank: 'asc' }, PAGE_SIZE, {
      fields: { genre: { eq: 'drama' }, rank: { gte: 50_000 } },
    })

    expect(ids).toEqual(expected)
    expect(new Set(totals)).toEqual(new Set([accepted.length]))
  })

  it('reads documents written since the last build in their place', async () => {
    await narsil.listDocuments('catalogue', { limit: 1, sort: { rank: 'asc' } })

    const addition = buildCatalogue(2_000, CORPUS_SIZE)
    await narsil.insertBatch(
      'catalogue',
      addition.map(entry => ({ ...entry })),
    )

    const expected = referenceOrder([...catalogue, ...addition], entry => [entry.rank], ['asc'])
    const { ids } = await walkEveryPage(narsil, 'catalogue', { rank: 'asc' }, PAGE_SIZE)

    expect(ids).toEqual(expected)
  })

  it('reads an updated sort value in its new place', async () => {
    await narsil.listDocuments('catalogue', { limit: 1, sort: { rank: 'asc' } })

    const moved = catalogue.slice(0, 50).map(entry => ({ ...entry, rank: 100_000 + entry.rank }))
    for (const entry of moved) {
      await narsil.update('catalogue', entry.id, { ...entry })
    }

    const updated = catalogue.map(entry => {
      const replacement = moved.find(candidate => candidate.id === entry.id)
      return replacement ?? entry
    })
    const expected = referenceOrder(updated, entry => [entry.rank], ['asc'])

    const { ids } = await walkEveryPage(narsil, 'catalogue', { rank: 'asc' }, PAGE_SIZE)

    expect(ids).toEqual(expected)
  })

  it('drops a removed document from a sorted page', async () => {
    await narsil.listDocuments('catalogue', { limit: 1, sort: { rank: 'asc' } })

    const removed = new Set(catalogue.slice(0, 200).map(entry => entry.id))
    for (const docId of removed) {
      await narsil.remove('catalogue', docId)
    }

    const expected = referenceOrder(
      catalogue.filter(entry => !removed.has(entry.id)),
      entry => [entry.rank],
      ['asc'],
    )
    const { ids, totals } = await walkEveryPage(narsil, 'catalogue', { rank: 'asc' }, PAGE_SIZE)

    expect(ids).toEqual(expected)
    expect(new Set(totals)).toEqual(new Set([CORPUS_SIZE - removed.size]))
  })

  it('orders a sorted query the same way it orders a listing', async () => {
    const accepted = catalogue.filter(entry => entry.genre === 'thriller')
    const expected = referenceOrder(accepted, entry => [entry.rank], ['desc']).slice(0, 25)

    const result = await narsil.query('catalogue', {
      term: 'catalogue',
      filters: { fields: { genre: { eq: 'thriller' } } },
      sort: { rank: 'desc' },
      limit: 25,
    })

    expect(result.hits.map(hit => hit.id)).toEqual(expected)
  })
})

describe('documents written between two values the order already holds', () => {
  let narsil: Narsil
  const built = Array.from({ length: 400 }, (_, index) => ({
    id: `built-${String(index).padStart(4, '0')}`,
    rank: index * 1_000,
  }))

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('gaps', { schema: { rank: 'number' }, language: 'english' })
    await narsil.insertBatch(
      'gaps',
      built.map(entry => ({ ...entry })),
    )
    await narsil.listDocuments('gaps', { limit: 1, sort: { rank: 'asc' } })
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('orders them among themselves by value rather than by document id', async () => {
    const moved = built.slice(0, 120).map((entry, index) => ({
      id: entry.id,
      rank: 999 - index,
    }))
    for (const entry of moved) {
      await narsil.update('gaps', entry.id, { rank: entry.rank })
    }

    const updated = built.map(entry => {
      const replacement = moved.find(candidate => candidate.id === entry.id)
      return replacement ?? entry
    })
    const expected = updated
      .slice()
      .sort((left, right) => left.rank - right.rank || (left.id < right.id ? -1 : 1))
      .map(entry => entry.id)

    const ids: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await narsil.listDocuments('gaps', { limit: 7, cursor, sort: { rank: 'asc' } })
      for (const entry of page.documents) ids.push(entry.id)
      if (page.cursor === null) break
      cursor = page.cursor
    }

    expect(ids).toEqual(expected)
  })
})

describe('sorted paging across several partitions', () => {
  let narsil: Narsil
  const catalogue = buildCatalogue(4_000)

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('split', { ...config, partitions: { maxDocsPerPartition: 500, maxPartitions: 32 } })
    await narsil.insertBatch(
      'split',
      catalogue.map(entry => ({ ...entry })),
    )
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('answers a partitioned index exactly as one partition would', async () => {
    const expected = referenceOrder(catalogue, entry => [entry.label], ['asc'])

    const { ids } = await walkEveryPage(narsil, 'split', { label: 'asc' }, 250)

    expect(ids).toEqual(expected)
  })

  it('holds the order when most partitions hold no matching document', async () => {
    const accepted = catalogue.filter(entry => entry.rank < 2_000)
    const expected = referenceOrder(accepted, entry => [entry.rank], ['desc'])

    const { ids, totals } = await walkEveryPage(narsil, 'split', { rank: 'desc' }, 25, {
      fields: { rank: { lt: 2_000 } },
    })

    expect(accepted.length).toBeGreaterThan(25)
    expect(ids).toEqual(expected)
    expect(new Set(totals)).toEqual(new Set([accepted.length]))
  })
})

describe('the sortable text opt-in', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('books', {
      schema: { title: 'string', edition: 'string:sortable', pages: 'number' },
      language: 'english',
    })
    await narsil.insert('books', { title: 'a tale', edition: 'first', pages: 300 }, 'b1')
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('refuses a listing sorted by an unmarked text field', async () => {
    await expect(narsil.listDocuments('books', { sort: { title: 'asc' } })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_FIELD,
    })
  })

  it('refuses a query sorted by an unmarked text field', async () => {
    await expect(narsil.query('books', { term: 'tale', sort: { title: 'asc' } })).rejects.toBeInstanceOf(NarsilError)
  })

  it('accepts a sort naming the field the schema marks', async () => {
    const page = await narsil.listDocuments('books', { sort: { edition: 'asc' } })

    expect(page.documents.map(entry => entry.id)).toEqual(['b1'])
  })

  it('still searches a field the schema marks sortable', async () => {
    const result = await narsil.query('books', { term: 'first', fields: ['edition'] })

    expect(result.hits.map(hit => hit.id)).toEqual(['b1'])
  })
})

describe('sort values the schema does not describe', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('mixed', { schema: { title: 'string:sortable' }, language: 'english' })
    await narsil.insert('mixed', { title: 'one', loose: 42 }, 'm1')
    await narsil.insert('mixed', { title: 'two', loose: 'apple' }, 'm2')
    await narsil.insert('mixed', { title: 'three', loose: true }, 'm3')
    await narsil.insert('mixed', { title: 'four' }, 'm4')
    await narsil.insert('mixed', { title: 'five', loose: 7 }, 'm5')
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('ranks numbers before strings before booleans, and missing values last', async () => {
    const page = await narsil.listDocuments('mixed', { sort: { loose: 'asc' }, limit: 10 })

    expect(page.documents.map(entry => entry.id)).toEqual(['m5', 'm1', 'm2', 'm3', 'm4'])
  })

  it('keeps a missing value last under a descending sort', async () => {
    const page = await narsil.listDocuments('mixed', { sort: { loose: 'desc' }, limit: 10 })

    expect(page.documents.map(entry => entry.id)).toEqual(['m3', 'm2', 'm1', 'm5', 'm4'])
  })
})

describe('the published string order', () => {
  let narsil: Narsil
  const words = ['', 'Apple', 'apple', 'Banana', 'FUSS', 'Fuß', 'fuss', 'Zebra', 'école']

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('words', { schema: { word: 'string:sortable' }, language: 'english' })
    for (let i = 0; i < words.length; i++) {
      await narsil.insert('words', { word: words[i] }, `w${String(i).padStart(2, '0')}`)
    }
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('reproduces the specification list exactly', async () => {
    const page = await narsil.listDocuments<{ word: string }>('words', { sort: { word: 'asc' }, limit: 20 })

    expect(page.documents.map(entry => entry.document.word)).toEqual(words)
  })
})
