import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { english } from '../../../languages/english'
import { french } from '../../../languages/french'
import { hausa } from '../../../languages/hausa'
import { registerLanguage } from '../../../languages/registry'
import { yoruba } from '../../../languages/yoruba'
import { createNarsil, type Narsil } from '../../../narsil'
import { DEFAULT_FUZZY_PREFIX_LENGTH } from '../../../search/constants'
import type { QueryParams } from '../../../types/search'
import {
  editDistance,
  foldOracle,
  generatedDocuments,
  HAUSA_HOOKED_LETTERS,
  idsWithWord,
  sharesLeadingPoints,
  YORUBA_QUERY_WORDS,
  YORUBA_WORDS,
} from './oracle'

const CORPUS_SIZE = 240
const CORPUS_SEED = 7
const EVERY_HIT = 1_000
const documents = generatedDocuments(CORPUS_SIZE, YORUBA_WORDS, CORPUS_SEED)

async function hitIds(narsil: Narsil, indexName: string, params: QueryParams): Promise<string[]> {
  const result = await narsil.query(indexName, { limit: EVERY_HIT, ...params })
  return result.hits.map(hit => hit.id).sort()
}

async function rankedIds(narsil: Narsil, indexName: string, params: QueryParams): Promise<string[]> {
  return (await narsil.query(indexName, { limit: EVERY_HIT, ...params })).hits.map(hit => hit.id)
}

describe('a query typed without marks in an index that folds', () => {
  let narsil: Narsil

  beforeAll(async () => {
    registerLanguage(yoruba)
    registerLanguage(hausa)
    registerLanguage(french)
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('yoruba', {
      schema: { body: 'string' },
      language: 'yoruba',
      partitions: { maxPartitions: 3 },
    })
    await narsil.insertBatch('yoruba', documents)
    await narsil.rebalance('yoruba', 3)
    await narsil.createIndex('plain', { schema: { body: 'string' }, language: 'yoruba', foldMarks: false })
    await narsil.insertBatch('plain', documents)
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  it('finds every document that holds a spelling whose fold is the query word', async () => {
    for (const query of YORUBA_QUERY_WORDS) {
      const expected = idsWithWord(documents, word => foldOracle(word) === query)
      expect(expected.length, query).toBeGreaterThan(0)
      expect(await hitIds(narsil, 'yoruba', { term: query }), query).toEqual(expected)
    }
  })

  it('finds the same documents for the marked spelling of the word', async () => {
    for (const marked of ['ọkọ̀', 'ìlú', 'ṣẹ́gun', 'ọ̀rẹ́']) {
      const expected = idsWithWord(documents, word => foldOracle(word) === foldOracle(marked))
      expect(await hitIds(narsil, 'yoruba', { term: marked }), marked).toEqual(expected)
    }
  })

  it('matches only the written spelling where the query sets exact', async () => {
    for (const query of ['oko', 'ọkọ', 'ile']) {
      const expected = idsWithWord(documents, word => word === query)
      expect(await hitIds(narsil, 'yoruba', { term: query, exact: true }), query).toEqual(expected)
    }
  })

  it('matches only the written spelling in an index that sets foldMarks to false', async () => {
    for (const query of YORUBA_QUERY_WORDS) {
      const expected = idsWithWord(documents, word => word === query)
      expect(await hitIds(narsil, 'plain', { term: query }), query).toEqual(expected)
    }
  })

  it('accepts a typo against the fold of a marked word', async () => {
    for (const word of YORUBA_QUERY_WORDS) {
      const query = `${word.slice(0, -1)}x`
      const accepts = (candidate: string): boolean =>
        sharesLeadingPoints(candidate, query, DEFAULT_FUZZY_PREFIX_LENGTH) && editDistance(candidate, query) <= 1
      const expected = idsWithWord(documents, candidate => accepts(candidate) || accepts(foldOracle(candidate)))
      expect(expected.length, query).toBeGreaterThan(0)
      expect(await hitIds(narsil, 'yoruba', { term: query, tolerance: 1 }), query).toEqual(expected)
    }
  })

  it('completes a half-typed word to the marked words whose fold starts with it', async () => {
    for (const word of YORUBA_QUERY_WORDS) {
      const typed = word.slice(0, 2)
      const expected = idsWithWord(
        documents,
        candidate => candidate.startsWith(typed) || foldOracle(candidate).startsWith(typed),
      )
      expect(await hitIds(narsil, 'yoruba', { term: typed, prefix: true }), typed).toEqual(expected)
    }
  })

  it('ranks the written spelling above a marked spelling that folds to it', async () => {
    await narsil.createIndex('ranking', { schema: { body: 'string' }, language: 'yoruba' })
    await narsil.insertBatch('ranking', [
      { id: 'marked', body: 'ọkọ kekere' },
      { id: 'plain', body: 'oko kekere' },
    ])
    expect(await rankedIds(narsil, 'ranking', { term: 'oko' })).toEqual(['plain', 'marked'])
    expect(await rankedIds(narsil, 'ranking', { term: 'ọkọ' })).toEqual(['marked', 'plain'])
    await narsil.dropIndex('ranking')
  })

  it('matches a quoted phrase whose words carry marks in the document', async () => {
    await narsil.createIndex('phrases', { schema: { body: 'string' }, language: 'yoruba' })
    await narsil.insertBatch('phrases', [
      { id: 'marked', body: 'ọkọ̀ kékeré' },
      { id: 'plain', body: 'oko kekere' },
      { id: 'reversed', body: 'kékeré ọkọ̀' },
    ])
    expect(await hitIds(narsil, 'phrases', { term: '"oko kekere"' })).toEqual(['marked', 'plain'])
    expect(await hitIds(narsil, 'phrases', { term: '"oko kekere"', exact: true })).toEqual(['plain'])
    await narsil.dropIndex('phrases')
  })

  it('replaces the hooked letters of Hausa', async () => {
    const hausaDocuments = [
      { id: 'hooked-room', body: 'ɗaki' },
      { id: 'plain-room', body: 'daki' },
      { id: 'hooked-door', body: 'ƙofa' },
      { id: 'plain-door', body: 'kofa' },
      { id: 'hooked-rat', body: 'ɓera' },
      { id: 'plain-rat', body: 'bera' },
    ]
    await narsil.createIndex('hausa', { schema: { body: 'string' }, language: 'hausa' })
    await narsil.insertBatch('hausa', hausaDocuments)
    for (const query of ['daki', 'kofa', 'bera']) {
      const expected = idsWithWord(hausaDocuments, word => foldOracle(word, HAUSA_HOOKED_LETTERS) === query)
      expect(await hitIds(narsil, 'hausa', { term: query }), query).toEqual(expected)
    }
    await narsil.dropIndex('hausa')
  })

  it('folds a French word before it stems it', async () => {
    await narsil.createIndex('french', { schema: { body: 'string' }, language: 'french' })
    await narsil.insertBatch('french', [
      { id: 'marked', body: 'après la pluie' },
      { id: 'plain', body: 'apres midi' },
    ])
    expect(await rankedIds(narsil, 'french', { term: 'apres' })).toEqual(['plain', 'marked'])
    expect(await rankedIds(narsil, 'french', { term: 'après' })).toEqual(['marked', 'plain'])
    await narsil.dropIndex('french')
  })
})

describe('an English index', () => {
  it('scores every query as an index that sets foldMarks to false scores it', async () => {
    registerLanguage(english)
    const narsil = await createNarsil({ workers: { enabled: false } })
    const englishDocuments = [
      { id: 'accented', body: 'café latte naïve résumé' },
      { id: 'plain', body: 'cafe mocha naive resume' },
      { id: 'other', body: 'coffee and tea' },
    ]
    try {
      await narsil.createIndex('default', { schema: { body: 'string' }, language: 'english' })
      await narsil.createIndex('unfolded', { schema: { body: 'string' }, language: 'english', foldMarks: false })
      await narsil.insertBatch('default', englishDocuments)
      await narsil.insertBatch('unfolded', englishDocuments)
      for (const params of [
        { term: 'cafe' },
        { term: 'café' },
        { term: 'naive resume', tolerance: 1 },
        { term: 'caf', prefix: true },
      ] satisfies QueryParams[]) {
        const folded = await narsil.query('default', params)
        const unfolded = await narsil.query('unfolded', params)
        expect(folded.hits.map(hit => [hit.id, hit.score])).toEqual(unfolded.hits.map(hit => [hit.id, hit.score]))
      }
    } finally {
      await narsil.shutdown()
    }
  })
})
