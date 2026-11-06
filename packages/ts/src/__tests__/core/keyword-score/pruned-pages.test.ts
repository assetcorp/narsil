import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Narsil } from '../../../narsil'
import { createNarsil } from '../../../narsil'
import {
  expectPageOfFullRanking,
  expectSortedMatchesOfFullRanking,
  KEYWORD_BACKENDS,
  scoreThrough,
  UNLIMITED,
} from './ranking'

const TERMS = ['alpha', 'beta', 'gamma', 'delta', 'omega']
const CORPUS_SIZE = 4000

function bodyFor(index: number): string {
  const repeats = (index % 7) + 1
  const filler = 'filler '.repeat((index % 23) + 1)
  const term = TERMS[index % TERMS.length]
  const second = index % 3 === 0 ? `${TERMS[(index + 1) % TERMS.length]} ` : ''
  return `${`${term} `.repeat(repeats)}${second}${filler}`
}

function titleFor(index: number): string {
  if (index % 3 === 0) return `alpha ${TERMS[index % TERMS.length]}`
  return TERMS[(index + 2) % TERMS.length]
}

function idOf(index: number): string {
  return `doc-${String(index).padStart(5, '0')}`
}

const QUERIES = [
  'alpha filler',
  'filler alpha',
  'alpha beta',
  'beta gamma filler',
  'alpha beta gamma delta omega',
  'alpha beta gamma delta omega filler',
  'omega delta',
  'alpha nowhere',
]

describe.each(KEYWORD_BACKENDS)('a keyword page under pruning through $name', backend => {
  scoreThrough(backend)
  let narsil: Narsil

  beforeAll(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('skewed', {
      schema: { title: 'string', body: 'string', rank: 'number' },
      language: 'english',
    })
    const documents = []
    for (let index = 0; index < CORPUS_SIZE; index++) {
      documents.push({ id: idOf(index), title: titleFor(index), body: bodyFor(index), rank: index })
    }
    await narsil.insertBatch('skewed', documents)
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  it('holds the first hits, scores, and count of the full ranking at every page size and offset', async () => {
    for (const term of QUERIES) await expectPageOfFullRanking(narsil, 'skewed', { term, limit: 10 })
    for (const limit of [1, 3, 25, 200]) {
      await expectPageOfFullRanking(narsil, 'skewed', { term: 'alpha filler', limit })
    }
    for (const offset of [1, 17, 250]) {
      await expectPageOfFullRanking(narsil, 'skewed', { term: 'beta gamma filler', limit: 10, offset })
    }
  })

  it('counts and collects every match, including the documents that pruning never scores', async () => {
    const narrow = await narsil.query('skewed', { term: 'omega filler', limit: 1 })
    expect(narrow.count).toBe(CORPUS_SIZE)
    const facets = { rank: {} }
    for (const term of QUERIES) await expectPageOfFullRanking(narsil, 'skewed', { term, limit: 3, facets })
    await expectPageOfFullRanking(narsil, 'skewed', {
      term: 'omega filler',
      limit: 1,
      facets,
      filters: { fields: { rank: { gte: 100, lt: 900 } } },
    })
  })

  it('applies minScore and termMatch before it cuts the page', async () => {
    const full = await narsil.query('skewed', { term: 'alpha beta filler', limit: CORPUS_SIZE })
    const middle = full.hits[Math.floor(full.hits.length / 2)].score
    const facets = { rank: {} }
    for (const minScore of [middle, full.hits[3].score, full.hits[0].score]) {
      await expectPageOfFullRanking(narsil, 'skewed', { term: 'alpha beta filler', limit: 5, minScore, facets })
    }
    for (const termMatch of ['all', 1, 2] as const) {
      await expectPageOfFullRanking(narsil, 'skewed', { term: 'alpha beta filler', limit: 5, termMatch, facets })
      await expectPageOfFullRanking(narsil, 'skewed', { term: 'omega delta', limit: 2, termMatch, facets })
    }
  })

  it('returns the same documents without a limit as the full ranking holds', async () => {
    for (const term of ['alpha filler', 'omega delta']) {
      await expectSortedMatchesOfFullRanking(narsil, 'skewed', { term })
    }
  })

  it('agrees with the full ranking under boosts, named fields, and a filter', async () => {
    await expectPageOfFullRanking(narsil, 'skewed', { term: 'alpha filler', limit: 10, boost: { title: 4 } })
    await expectPageOfFullRanking(narsil, 'skewed', { term: 'alpha beta', limit: 10, boost: { title: 0 } }, UNLIMITED)
    for (const fields of [['title'], ['body'], ['title', 'body']]) {
      for (const term of QUERIES) await expectPageOfFullRanking(narsil, 'skewed', { term, limit: 10, fields })
      await expectPageOfFullRanking(narsil, 'skewed', { term: 'omega gamma', limit: 5, offset: 30, fields })
    }
    await expectPageOfFullRanking(narsil, 'skewed', {
      term: 'alpha filler',
      limit: 10,
      filters: { fields: { rank: { gte: 100, lt: 900 } } },
    })
  })

  it('keeps agreeing after removals and updates leave retired rows in the posting lists', async () => {
    await narsil.remove('skewed', idOf(3))
    await narsil.update('skewed', idOf(6), {
      id: idOf(6),
      title: 'alpha alpha alpha alpha beta',
      body: 'alpha beta filler',
      rank: 6,
    })
    for (let index = 30; index < 90; index++) await narsil.remove('skewed', idOf(index))
    await narsil.update('skewed', idOf(9), { id: idOf(9), title: '', body: '', rank: 9 })
    await narsil.waitForWrites('skewed')
    const facets = { rank: {} }
    for (const term of QUERIES) await expectPageOfFullRanking(narsil, 'skewed', { term, limit: 10, facets })
    const page = await narsil.query('skewed', { term: 'alpha beta', limit: 1 })
    expect(page.hits[0].id).toBe(idOf(6))
  })
})

describe.each(KEYWORD_BACKENDS)('a pruned page at its edges through $name', backend => {
  scoreThrough(backend)

  it('returns every document that ties the last kept score, in document ID order', async () => {
    const narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('tied', { schema: { title: 'string', rank: 'number' }, language: 'english' })
    const documents = []
    for (let index = 0; index < 3000; index++) {
      documents.push({ id: `t-${String(3000 - index).padStart(5, '0')}`, title: 'alpha beta gamma', rank: index })
    }
    for (let index = 0; index < 40; index++) {
      documents.push({
        id: `s-${String(index).padStart(5, '0')}`,
        title: 'alpha gamma alpha gamma',
        rank: 3000 + index,
      })
    }
    await narsil.insertBatch('tied', documents)
    for (const limit of [1, 5, 39, 40, 41, 50]) {
      await expectPageOfFullRanking(narsil, 'tied', { term: 'alpha gamma', limit, facets: { rank: {} } })
      await expectPageOfFullRanking(narsil, 'tied', { term: 'alpha gamma', limit, offset: 7 })
    }
    await narsil.shutdown()
  })

  it('finds a winner in the last block of the rarest list after the page is already full', async () => {
    const narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('late', { schema: { title: 'string', body: 'string' }, language: 'english' })
    const documents = []
    for (let index = 0; index < 5000; index++) {
      documents.push({ id: idOf(index), title: index % 2 === 0 ? 'alpha' : 'beta', body: 'common padding text here' })
    }
    documents.push({ id: 'doc-99999', title: 'alpha alpha alpha alpha alpha alpha beta', body: 'common' })
    await narsil.insertBatch('late', documents)
    const page = await narsil.query('late', { term: 'alpha beta common', limit: 3 })
    expect(page.hits[0].id).toBe('doc-99999')
    expect(page.count).toBe(5001)
    await expectPageOfFullRanking(narsil, 'late', { term: 'alpha beta common', limit: 3 })
    await narsil.shutdown()
  })

  it('agrees with the full ranking when a negative boost lowers the early leaders', async () => {
    const narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('lowered', { schema: { title: 'string', body: 'string' }, language: 'english' })
    const documents = []
    for (let index = 0; index < 15; index++) {
      documents.push({ id: `x-${String(index).padStart(5, '0')}`, title: 'alpha', body: 'beta beta beta beta beta' })
    }
    for (let index = 0; index < 2000; index++) {
      documents.push({ id: `y-${String(index).padStart(5, '0')}`, title: 'beta', body: 'filler' })
      documents.push({ id: `z-${String(index).padStart(5, '0')}`, title: 'gamma', body: 'filler' })
    }
    await narsil.insertBatch('lowered', documents)
    const params = { term: 'alpha beta', limit: 10, boost: { body: -10 } }
    await expectPageOfFullRanking(narsil, 'lowered', params, UNLIMITED)
    const page = await narsil.query('lowered', params)
    expect(page.hits.every(hit => hit.id.startsWith('y-'))).toBe(true)
    await narsil.shutdown()
  })

  it('agrees with the full ranking at the edges of the bm25 parameter ranges', async () => {
    const narsil = await createNarsil({ workers: { enabled: false } })
    const documents = []
    for (let index = 0; index < 3000; index++) {
      documents.push({
        id: `d-${String(index).padStart(5, '0')}`,
        title: `${'alpha '.repeat((index % 9) + 1)}${'padding '.repeat(index % 200)}`,
        body: index % 4 === 0 ? 'beta body text' : 'body text',
      })
    }
    for (const bm25 of [
      { b: 0, k1: 1.2 },
      { b: 1, k1: 1.2 },
      { b: 0.75, k1: 0 },
    ]) {
      const indexName = `b-${bm25.b}-k1-${bm25.k1}`
      await narsil.createIndex(indexName, { schema: { title: 'string', body: 'string' }, language: 'english', bm25 })
      await narsil.insertBatch(indexName, documents)
      await expectPageOfFullRanking(narsil, indexName, { term: 'alpha padding', limit: 10 })
      await expectPageOfFullRanking(narsil, indexName, { term: 'alpha beta text', limit: 10, offset: 20 })
    }
    await narsil.shutdown()
  })
})
