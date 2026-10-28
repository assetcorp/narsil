import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { QueryParams } from '../../types/search'
import { type CorpusDocument, corpus, corpusIndex, letterEmbedding, stored } from '../rerank/corpus'
import {
  cosineOf,
  oracleRerank,
  oracleRrf,
  overlapScore,
  type RankedHit,
  recordingReranker,
  rerankTextOf,
} from '../rerank/oracle'

const INDEX = 'docs'
const TERM = 'glass ember'
const VECTOR_TEXT = 'lantern'

async function failureOf(promise: Promise<unknown>): Promise<NarsilError> {
  const outcome = await promise.then(
    () => null,
    (err: unknown) => err,
  )
  expect(outcome).toBeInstanceOf(NarsilError)
  return outcome as NarsilError
}

describe('hybrid paging to a fixed depth', () => {
  let narsil: Narsil
  let documents: CorpusDocument[]

  beforeEach(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex(INDEX, corpusIndex)
    documents = corpus(160, 11)
    for (const document of documents) await narsil.insert(INDEX, stored(document), document.id)
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  function hybridQuery(depth?: number): QueryParams {
    return {
      term: TERM,
      termMatch: 'any',
      vector: { field: 'embedding', text: VECTOR_TEXT },
      ...(depth === undefined ? {} : { hybrid: { depth } }),
    }
  }

  async function textLeg(depth: number): Promise<RankedHit[]> {
    const result = await narsil.query(INDEX, { term: TERM, termMatch: 'any', limit: depth })
    return result.hits.map(hit => ({ id: hit.id, score: hit.score ?? 0 }))
  }

  async function vectorLeg(depth: number): Promise<RankedHit[]> {
    const result = await narsil.query(INDEX, { vector: { field: 'embedding', text: VECTOR_TEXT }, limit: depth })
    const hits = result.hits.map(hit => ({ id: hit.id, score: hit.score ?? 0 }))
    const query = letterEmbedding(VECTOR_TEXT)
    const byId = new Map(documents.map(document => [document.id, document]))
    const cosines = documents
      .map(document => cosineOf(letterEmbedding(document.title), query))
      .sort((a, b) => b - a)
      .slice(0, depth)
    for (const [i, hit] of hits.entries()) {
      const document = byId.get(hit.id) as CorpusDocument
      expect(hit.score).toBeCloseTo(cosineOf(letterEmbedding(document.title), query), 5)
      expect(hit.score).toBeCloseTo(cosines[i], 5)
    }
    return hits
  }

  async function oracleFused(depth: number): Promise<RankedHit[]> {
    return oracleRrf([await textLeg(depth), await vectorLeg(depth)]).slice(0, depth)
  }

  async function walkByCursor(params: QueryParams, limit: number): Promise<RankedHit[]> {
    const seen: RankedHit[] = []
    let cursor: string | undefined
    for (let page = 0; page < 200; page++) {
      const result = await narsil.query(INDEX, { ...params, limit, searchAfter: cursor })
      seen.push(...result.hits.map(hit => ({ id: hit.id, score: hit.score ?? 0 })))
      cursor = result.cursor
      if (cursor === undefined) return seen
    }
    throw new Error('the cursor never ran out')
  }

  async function walkByOffset(params: QueryParams, limit: number, depth: number): Promise<RankedHit[]> {
    const seen: RankedHit[] = []
    for (let offset = 0; offset + limit <= depth; offset += limit) {
      const result = await narsil.query(INDEX, { ...params, limit, offset })
      seen.push(...result.hits.map(hit => ({ id: hit.id, score: hit.score ?? 0 })))
    }
    return seen
  }

  function expectSameOrder(actual: RankedHit[], expected: RankedHit[]): void {
    expect(actual.map(hit => hit.id)).toEqual(expected.map(hit => hit.id))
    for (const [i, hit] of actual.entries()) expect(hit.score).toBeCloseTo(expected[i].score, 9)
  }

  it.each([
    20, 35,
  ])('returns one fused order at depth %i, whether a caller pages by cursor or by offset', async depth => {
    const expected = await oracleFused(depth)

    expectSameOrder(await walkByCursor(hybridQuery(depth), 5), expected)
    expectSameOrder(await walkByOffset(hybridQuery(depth), 5, depth), expected.slice(0, Math.floor(depth / 5) * 5))
  })

  it('fuses each leg to 100 results where the query leaves the depth out, and reads every one by cursor at limit 7', async () => {
    const expected = await oracleFused(100)
    expect(expected).toHaveLength(100)
    expectSameOrder(await walkByCursor(hybridQuery(), 7), expected)
    expectSameOrder(await walkByCursor(hybridQuery(100), 7), expected)
  })

  it('places a pin from outside the fused list on the first page and resumes after the last fused hit', async () => {
    const fused = await oracleFused(30)
    const outside = documents.find(document => !fused.some(hit => hit.id === document.id)) as CorpusDocument
    const inside = fused[12].id
    const pinned = [
      { docId: outside.id, position: 1 },
      { docId: inside, position: 3 },
    ]

    const first = await narsil.query(INDEX, { ...hybridQuery(30), pinned, limit: 6 })
    const placed = fused.map(hit => hit.id).filter(id => id !== inside)
    placed.splice(1, 0, outside.id)
    placed.splice(3, 0, inside)
    expect(first.hits.map(hit => hit.id)).toEqual(placed.slice(0, 6))

    const rest: string[] = []
    let cursor = first.cursor
    while (cursor !== undefined) {
      const page = await narsil.query(INDEX, { ...hybridQuery(30), pinned, limit: 2, searchAfter: cursor })
      rest.push(...page.hits.map(hit => hit.id))
      cursor = page.cursor
    }
    expect(rest).toEqual(fused.slice(4).map(hit => hit.id))
  })

  it('reaches every fused hit by cursor where pins from outside fill the first page', async () => {
    const fused = await oracleFused(10)
    expect(fused).toHaveLength(10)
    const outside = documents.filter(document => !fused.some(hit => hit.id === document.id)).slice(0, 2)
    const pinned = outside.map((document, position) => ({ docId: document.id, position }))

    const first = await narsil.query(INDEX, { ...hybridQuery(10), pinned, limit: 10 })
    expect(first.hits.map(hit => hit.id)).toEqual([
      ...pinned.map(pin => pin.docId),
      ...fused.slice(0, 8).map(hit => hit.id),
    ])
    const second = await narsil.query(INDEX, { ...hybridQuery(10), pinned, limit: 10, searchAfter: first.cursor })

    expect(second.hits.map(hit => hit.id)).toEqual(fused.slice(8).map(hit => hit.id))
    expect(second.cursor).toBeUndefined()
  })

  it('serves a short last page up to the depth, and refuses a page that starts at the depth', async () => {
    const expected = await oracleFused(20)
    const last = await narsil.query(INDEX, { ...hybridQuery(20), offset: 15, limit: 10 })
    expectSameOrder(
      last.hits.map(hit => ({ id: hit.id, score: hit.score ?? 0 })),
      expected.slice(15),
    )
    expect(last.cursor).toBeUndefined()
    const failure = await failureOf(narsil.query(INDEX, { ...hybridQuery(20), offset: 20, limit: 1 }))
    expect(failure.code).toBe(ErrorCodes.SEARCH_RESULT_WINDOW_EXCEEDED)
    expect(failure.message).toContain('hybrid.depth')
  })

  it.each([0, 10_001, 2.5, -1, Number.NaN])('refuses a depth of %s', async depth => {
    const failure = await failureOf(narsil.query(INDEX, hybridQuery(depth)))
    expect(failure.code).not.toBe(ErrorCodes.SEARCH_RESULT_WINDOW_EXCEEDED)
  })

  it('refuses a cursor sent back with another depth', async () => {
    const first = await narsil.query(INDEX, { ...hybridQuery(20), limit: 5 })
    const failure = await failureOf(narsil.query(INDEX, { ...hybridQuery(30), limit: 5, searchAfter: first.cursor }))
    expect(failure.code).toBe(ErrorCodes.SEARCH_INVALID_CURSOR)
  })

  it('reranks the fused order at the hybrid depth, with one order on every page', async () => {
    narsil.registerRerankAdapter('overlap', recordingReranker())
    const fields = ['title', 'tags']
    const fused = await oracleFused(40)
    const byId = new Map(documents.map(document => [document.id, document]))
    const scores = fused
      .slice(0, 15)
      .map(hit => overlapScore(TERM, rerankTextOf(stored(byId.get(hit.id) as CorpusDocument), fields)))
    const expected = oracleRerank(fused, 15, scores)

    const walked = await walkByCursor({ ...hybridQuery(40), rerank: { adapter: 'overlap', fields, window: 15 } }, 6)

    expectSameOrder(walked, expected)
  })

  it('reranks the whole fused list where the query sets hybrid.depth 20 and leaves the window out', async () => {
    const reranker = recordingReranker()
    narsil.registerRerankAdapter('overlap', reranker)
    const fields = ['title']
    const fused = await oracleFused(20)
    expect(fused).toHaveLength(20)
    const byId = new Map(documents.map(document => [document.id, document]))
    const scores = fused.map(hit =>
      overlapScore(TERM, rerankTextOf(stored(byId.get(hit.id) as CorpusDocument), fields)),
    )
    const expected = oracleRerank(fused, 20, scores)

    const walked = await walkByCursor({ ...hybridQuery(20), rerank: { adapter: 'overlap', fields } }, 6)

    expectSameOrder(walked, expected)
    expect(reranker.calls.length).toBeGreaterThan(0)
    expect(reranker.calls.every(call => call.documents.length === 20)).toBe(true)
  })

  it('refuses a rerank window larger than the hybrid depth', async () => {
    narsil.registerRerankAdapter('overlap', recordingReranker())
    const failure = await failureOf(
      narsil.query(INDEX, { ...hybridQuery(20), rerank: { adapter: 'overlap', fields: ['title'], window: 21 } }),
    )
    expect(failure.code).toBe(ErrorCodes.RERANK_CONFIG_INVALID)
  })
})
