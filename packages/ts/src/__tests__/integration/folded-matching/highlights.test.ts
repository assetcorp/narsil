import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerLanguage } from '../../../languages/registry'
import { yoruba } from '../../../languages/yoruba'
import { createNarsil, type Narsil } from '../../../narsil'
import type { QueryParams } from '../../../types/search'
import { editDistance, foldOracle, sharesLeadingPoints, wordSpans } from './oracle'

const BODY = 'ọkọ̀ kékeré ilé ọ̀rẹ́ ìwé'
const NAME = 'ayọkẹlẹ ọkọ̀ ìwé'

async function spansOf(narsil: Narsil, params: QueryParams, field: 'body' | 'name' = 'body') {
  const result = await narsil.query('words', { ...params, highlight: { fields: [field] } })
  return result.hits.find(hit => hit.id === 'marked')?.highlights?.[field]?.positions
}

describe('highlighting a query typed without marks', () => {
  let narsil: Narsil

  beforeAll(async () => {
    registerLanguage(yoruba)
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('words', { schema: { body: 'string', name: 'string:partial' }, language: 'yoruba' })
    await narsil.insertBatch('words', [
      { id: 'marked', body: BODY, name: NAME },
      { id: 'other', body: 'eja oja', name: 'agba' },
    ])
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  it('marks the whole marked word, tone marks included, for each query word', async () => {
    const queryWords = new Set(['oko', 'ile', 'ore'])
    const expected = wordSpans(BODY, word => queryWords.has(foldOracle(word)))
    expect(expected).toHaveLength(3)
    expect(await spansOf(narsil, { term: 'oko ile ore' })).toEqual(expected)
  })

  it('marks a marked word whose fold is one typo away from the query word', async () => {
    const query = 'kekere'.replace(/e$/, 'a')
    const expected = wordSpans(
      BODY,
      word => sharesLeadingPoints(foldOracle(word), query, 2) && editDistance(foldOracle(word), query) <= 1,
    )
    expect(expected).toHaveLength(1)
    expect(await spansOf(narsil, { term: query, tolerance: 1 })).toEqual(expected)
  })

  it('marks a marked word whose fold starts with a half-typed word', async () => {
    const expected = wordSpans(BODY, word => foldOracle(word).startsWith('ke'))
    expect(await spansOf(narsil, { term: 'ke', prefix: true })).toEqual(expected)
  })

  it('marks the marked words of a quoted phrase', async () => {
    const phrase = new Set(['kekere', 'ile'])
    const expected = wordSpans(BODY, word => phrase.has(foldOracle(word)))
    expect(await spansOf(narsil, { term: '"kekere ile"' })).toEqual(expected)
  })

  it('marks a longer marked word whose fold holds a partial query word', async () => {
    const expected = wordSpans(NAME, word => {
      const fold = foldOracle(word)
      return fold.length > 'oke'.length && fold.includes('oke')
    })
    expect(expected).toHaveLength(1)
    expect(await spansOf(narsil, { term: 'oke', partialWords: true }, 'name')).toEqual(expected)
  })

  it('marks only the written spelling where the query sets exact', async () => {
    const result = await narsil.query('words', { term: 'oko', exact: true, highlight: { fields: ['body'] } })
    expect(result.hits).toEqual([])
    expect(await spansOf(narsil, { term: 'ọkọ̀', exact: true })).toEqual(wordSpans(BODY, word => word === 'ọkọ̀'))
  })
})
