import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Narsil } from '../../../narsil'
import { createNarsil } from '../../../narsil'
import type { QueryParams } from '../../../types/search'

vi.mock('../../../core/partition/constants', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../core/partition/constants')>()),
  MULTI_TERM_PRUNING_POSTINGS_THRESHOLD: 0,
}))

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

async function buildIndex(): Promise<Narsil> {
  const narsil = await createNarsil({ workers: { enabled: false } })
  await narsil.createIndex('skewed', {
    schema: { title: 'string', body: 'string', rank: 'number' },
    language: 'english',
  })
  const documents = []
  for (let index = 0; index < CORPUS_SIZE; index++) {
    documents.push({
      id: `doc-${String(index).padStart(5, '0')}`,
      title: titleFor(index),
      body: bodyFor(index),
      rank: index,
    })
  }
  await narsil.insertBatch('skewed', documents)
  return narsil
}

async function comparePrunedWithFull(narsil: Narsil, indexName: string, params: QueryParams): Promise<void> {
  const pruned = await narsil.query(indexName, params)
  const full = await narsil.query(indexName, { ...params, includeScoreComponents: true })

  expect(pruned.count).toBe(full.count)
  expect(pruned.hits.map(hit => hit.id)).toEqual(full.hits.map(hit => hit.id))
  for (let index = 0; index < pruned.hits.length; index++) {
    expect(Object.is(pruned.hits[index].score, full.hits[index].score)).toBe(true)
  }
}

const QUERIES = [
  'alpha filler',
  'filler alpha',
  'alpha beta',
  'beta gamma filler',
  'alpha beta gamma delta omega',
  'alpha beta gamma delta omega filler',
  'omega delta',
]

describe('pruned multi-term scoring', () => {
  let narsil: Narsil

  beforeAll(async () => {
    narsil = await buildIndex()
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  it('returns the same page, scores, and count as the unpruned path for every query', async () => {
    for (const term of QUERIES) {
      await comparePrunedWithFull(narsil, 'skewed', { term, limit: 10 })
    }
  })

  it('agrees with the unpruned path across page sizes and offsets', async () => {
    for (const limit of [1, 3, 25, 200, 4000]) {
      await comparePrunedWithFull(narsil, 'skewed', { term: 'alpha filler', limit })
    }
    for (const offset of [1, 17, 250]) {
      await comparePrunedWithFull(narsil, 'skewed', { term: 'beta gamma filler', limit: 10, offset })
    }
  })

  it('counts every match when the common term is never fully scored', async () => {
    const narrow = await narsil.query('skewed', { term: 'omega filler', limit: 1 })
    const wide = await narsil.query('skewed', { term: 'omega filler', limit: 4000 })
    expect(narrow.count).toBe(CORPUS_SIZE)
    expect(narrow.count).toBe(wide.count)
    expect(narrow.hits[0].id).toBe(wide.hits[0].id)
  })

  it('agrees when a query term is absent from the index', async () => {
    await comparePrunedWithFull(narsil, 'skewed', { term: 'alpha nowhere', limit: 10 })
    await comparePrunedWithFull(narsil, 'skewed', { term: 'nowhere elsewhere', limit: 10 })
  })

  it('keeps agreeing after a document is removed', async () => {
    await narsil.remove('skewed', 'doc-00003')
    await comparePrunedWithFull(narsil, 'skewed', { term: 'alpha filler', limit: 10 })
    await comparePrunedWithFull(narsil, 'skewed', { term: 'gamma delta', limit: 10 })
  })

  it('keeps agreeing after a document is updated', async () => {
    await narsil.update('skewed', 'doc-00006', {
      id: 'doc-00006',
      title: 'alpha alpha alpha alpha beta',
      body: 'alpha beta filler',
      rank: 6,
    })
    await comparePrunedWithFull(narsil, 'skewed', { term: 'alpha beta', limit: 10 })
    await comparePrunedWithFull(narsil, 'skewed', { term: 'alpha beta filler', limit: 4000 })
    const page = await narsil.query('skewed', { term: 'alpha beta', limit: 1 })
    expect(page.hits[0].id).toBe('doc-00006')
  })

  it('keeps agreeing while tombstones remain in the posting lists', async () => {
    for (let index = 30; index < 90; index++) {
      await narsil.remove('skewed', `doc-${String(index).padStart(5, '0')}`)
    }
    await narsil.waitForWrites('skewed')
    for (const term of QUERIES) {
      await comparePrunedWithFull(narsil, 'skewed', { term, limit: 10 })
    }
    await comparePrunedWithFull(narsil, 'skewed', { term: 'alpha filler', limit: 4000 })
  })

  it('agrees with the unpruned path under a field boost', async () => {
    await comparePrunedWithFull(narsil, 'skewed', { term: 'alpha filler', limit: 10, boost: { title: 4 } })
    await comparePrunedWithFull(narsil, 'skewed', { term: 'alpha beta', limit: 10, boost: { title: 0 } })
  })

  it('agrees with the unpruned path when the query names fields or carries a filter', async () => {
    for (const fields of [['title'], ['body'], ['title', 'body']]) {
      for (const term of QUERIES) {
        await comparePrunedWithFull(narsil, 'skewed', { term, limit: 10, fields })
      }
      await comparePrunedWithFull(narsil, 'skewed', { term: 'alpha filler', limit: 4000, fields })
      await comparePrunedWithFull(narsil, 'skewed', { term: 'omega gamma', limit: 5, offset: 30, fields })
    }
    const titleOnly = await narsil.query('skewed', { term: 'omega filler', limit: 1, fields: ['title'] })
    const everywhere = await narsil.query('skewed', { term: 'omega filler', limit: 1 })
    expect(titleOnly.count).toBeLessThan(everywhere.count)
    await comparePrunedWithFull(narsil, 'skewed', {
      term: 'alpha filler',
      limit: 10,
      filters: { fields: { rank: { gte: 100, lt: 900 } } },
    })
  })

  it('finds a winner that sits in the last block of the rare list, after the page is already full', async () => {
    const late = await createNarsil({ workers: { enabled: false } })
    await late.createIndex('late', { schema: { title: 'string', body: 'string' }, language: 'english' })
    const documents = []
    for (let index = 0; index < 5000; index++) {
      documents.push({
        id: `doc-${String(index).padStart(5, '0')}`,
        title: index % 2 === 0 ? 'alpha' : 'beta',
        body: 'common padding text here',
      })
    }
    documents.push({ id: 'doc-99999', title: 'alpha alpha alpha alpha alpha alpha beta', body: 'common' })
    await late.insertBatch('late', documents)

    const pruned = await late.query('late', { term: 'alpha beta common', limit: 3 })
    const full = await late.query('late', { term: 'alpha beta common', limit: 3, includeScoreComponents: true })
    expect(pruned.hits[0].id).toBe('doc-99999')
    expect(pruned.hits.map(hit => hit.id)).toEqual(full.hits.map(hit => hit.id))
    expect(pruned.count).toBe(full.count)
    expect(pruned.count).toBe(5001)
    await late.shutdown()
  })

  it('breaks score ties the same way as the unpruned path', async () => {
    const tied = await createNarsil({ workers: { enabled: false } })
    await tied.createIndex('tied', { schema: { title: 'string' }, language: 'english' })
    const documents = []
    for (let index = 0; index < 3000; index++) {
      documents.push({ id: `t-${String(3000 - index).padStart(5, '0')}`, title: 'alpha beta gamma' })
    }
    await tied.insertBatch('tied', documents)
    for (const limit of [1, 5, 10, 50]) {
      await comparePrunedWithFull(tied, 'tied', { term: 'alpha gamma', limit })
      await comparePrunedWithFull(tied, 'tied', { term: 'alpha gamma', limit, offset: 7 })
    }
    await tied.shutdown()
  })
})

describe('bm25 parameters and the pruned multi-term scan', () => {
  const CONFIGS = [
    { indexName: 'b-zero', b: 0, k1: 1.2 },
    { indexName: 'b-one', b: 1, k1: 1.2 },
    { indexName: 'k-zero', b: 0.75, k1: 0 },
  ]
  let engine: Narsil

  beforeAll(async () => {
    engine = await createNarsil({ workers: { enabled: false } })
    const documents = []
    for (let index = 0; index < 3000; index++) {
      const repeats = (index % 9) + 1
      const padding = 'padding '.repeat(index % 200)
      documents.push({
        id: `d-${String(index).padStart(5, '0')}`,
        title: `${'alpha '.repeat(repeats)}${padding}`,
        body: index % 4 === 0 ? 'beta body text' : 'body text',
      })
    }
    for (const config of CONFIGS) {
      await engine.createIndex(config.indexName, {
        schema: { title: 'string', body: 'string' },
        language: 'english',
        bm25: { b: config.b, k1: config.k1 },
      })
      await engine.insertBatch(config.indexName, documents)
    }
  })

  afterAll(async () => {
    await engine.shutdown()
  })

  it('agrees with the unpruned path at the edges of the parameter ranges', async () => {
    for (const config of CONFIGS) {
      await comparePrunedWithFull(engine, config.indexName, { term: 'alpha padding', limit: 10 })
      await comparePrunedWithFull(engine, config.indexName, { term: 'alpha beta text', limit: 10, offset: 20 })
    }
  })
})
