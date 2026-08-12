import { beforeAll, describe, expect, it } from 'vitest'
import type { Narsil } from '../../../narsil'
import { createNarsil } from '../../../narsil'
import type { QueryParams } from '../../../types/search'

const TERMS = ['alpha', 'beta', 'gamma', 'delta', 'omega']
const CORPUS_SIZE = 4000

function bodyFor(index: number): string {
  const repeats = (index % 7) + 1
  const filler = 'filler '.repeat((index % 23) + 1)
  const term = TERMS[index % TERMS.length]
  return `${`${term} `.repeat(repeats)}${filler}`
}

function titleFor(index: number): string {
  if (index % 3 === 0) return `alpha ${TERMS[index % TERMS.length]}`
  return TERMS[(index + 2) % TERMS.length]
}

async function buildIndex(): Promise<Narsil> {
  const narsil = await createNarsil()
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

async function comparePrunedWithFull(narsil: Narsil, params: QueryParams): Promise<void> {
  const pruned = await narsil.query('skewed', params)
  const full = await narsil.query('skewed', { ...params, includeScoreComponents: true })

  expect(pruned.count).toBe(full.count)
  expect(pruned.hits.map(hit => hit.id)).toEqual(full.hits.map(hit => hit.id))
  for (let index = 0; index < pruned.hits.length; index++) {
    expect(Object.is(pruned.hits[index].score, full.hits[index].score)).toBe(true)
  }
}

describe('pruned single-term scoring', () => {
  let narsil: Narsil

  beforeAll(async () => {
    narsil = await buildIndex()
  })

  it('returns the same page, scores, and count as the unpruned path for every term', async () => {
    for (const term of TERMS) {
      await comparePrunedWithFull(narsil, { term, limit: 10 })
    }
  })

  it('agrees with the unpruned path across page sizes and offsets', async () => {
    for (const limit of [1, 3, 25, 200]) {
      await comparePrunedWithFull(narsil, { term: 'alpha', limit })
    }
    for (const offset of [1, 17, 250]) {
      await comparePrunedWithFull(narsil, { term: 'alpha', limit: 10, offset })
    }
  })

  it('counts every match when whole blocks are ruled out', async () => {
    const narrow = await narsil.query('skewed', { term: 'alpha', limit: 1 })
    const wide = await narsil.query('skewed', { term: 'alpha', limit: 4000 })
    expect(narrow.count).toBe(wide.count)
    expect(narrow.hits[0].id).toBe(wide.hits[0].id)
  })

  it('keeps agreeing after a document is removed', async () => {
    await narsil.remove('skewed', 'doc-00003')
    await comparePrunedWithFull(narsil, { term: 'alpha', limit: 10 })
    await comparePrunedWithFull(narsil, { term: 'gamma', limit: 10 })
  })

  it('keeps agreeing after a document is updated', async () => {
    await narsil.update('skewed', 'doc-00006', {
      id: 'doc-00006',
      title: 'alpha alpha alpha alpha',
      body: 'alpha',
      rank: 6,
    })
    await comparePrunedWithFull(narsil, { term: 'alpha', limit: 10 })
    await comparePrunedWithFull(narsil, { term: 'alpha', limit: 4000 })
    const page = await narsil.query('skewed', { term: 'alpha', limit: 4000 })
    expect(page.hits.some(hit => hit.id === 'doc-00006')).toBe(true)
  })

  it('agrees with the unpruned path under a field boost', async () => {
    await comparePrunedWithFull(narsil, { term: 'alpha', limit: 10, boost: { title: 4 } })
    await comparePrunedWithFull(narsil, { term: 'alpha', limit: 10, boost: { title: 0 } })
  })

  it('agrees with the unpruned path when the query names one field', async () => {
    await comparePrunedWithFull(narsil, { term: 'alpha', limit: 10, fields: ['title'] })
    await comparePrunedWithFull(narsil, { term: 'alpha', limit: 10, fields: ['body'] })
  })

  it('finds a winner that sits in the last block, after the page is already full', async () => {
    const late = await createNarsil()
    await late.createIndex('late', { schema: { title: 'string', body: 'string' }, language: 'english' })
    const documents = []
    for (let index = 0; index < 5000; index++) {
      documents.push({ id: `doc-${String(index).padStart(5, '0')}`, title: 'alpha', body: 'padding text here' })
    }
    documents.push({ id: 'doc-99999', title: 'alpha alpha alpha alpha alpha alpha', body: 'alpha' })
    await late.insertBatch('late', documents)

    const pruned = await late.query('late', { term: 'alpha', limit: 3 })
    const full = await late.query('late', { term: 'alpha', limit: 3, includeScoreComponents: true })
    expect(pruned.hits[0].id).toBe('doc-99999')
    expect(pruned.hits.map(hit => hit.id)).toEqual(full.hits.map(hit => hit.id))
    expect(pruned.count).toBe(full.count)
    await late.shutdown()
  })

  it('agrees with the unpruned path under a filter', async () => {
    await comparePrunedWithFull(narsil, {
      term: 'alpha',
      limit: 10,
      filters: { fields: { rank: { gte: 100, lt: 900 } } },
    })
  })
})
