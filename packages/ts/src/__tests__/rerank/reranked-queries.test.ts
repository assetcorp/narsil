import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { RerankAdapter } from '../../types/adapters'
import type { QueryParams } from '../../types/search'
import { type CorpusDocument, corpus, corpusIndex, letterEmbedding, stored } from './corpus'
import {
  compareCodePointOrder,
  oracleRerank,
  overlapScore,
  type RankedHit,
  recordingReranker,
  rerankTextOf,
} from './oracle'

const INDEX = 'docs'

async function failureOf(promise: Promise<unknown>): Promise<NarsilError> {
  const outcome = await promise.then(
    () => null,
    (err: unknown) => err,
  )
  expect(outcome).toBeInstanceOf(NarsilError)
  return outcome as NarsilError
}

describe('reranked queries on one engine', () => {
  let narsil: Narsil
  let documents: CorpusDocument[]
  let byId: Map<string, CorpusDocument>

  beforeEach(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex(INDEX, corpusIndex)
    documents = corpus(60)
    byId = new Map(documents.map(document => [document.id, document]))
    for (const document of documents) await narsil.insert(INDEX, stored(document), document.id)
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  async function firstStage(params: QueryParams): Promise<RankedHit[]> {
    const result = await narsil.query(INDEX, { ...params, limit: 10_000, offset: 0 })
    return result.hits.map(hit => ({ id: hit.id, score: hit.score ?? 0 }))
  }

  function oracleOrder(first: RankedHit[], window: number, query: string, fields: string[]): RankedHit[] {
    const head = first.slice(0, window)
    const scores = head.map(hit =>
      overlapScore(query, rerankTextOf(stored(byId.get(hit.id) as CorpusDocument), fields)),
    )
    return oracleRerank(first, window, scores)
  }

  async function walkPages(params: QueryParams, limit: number): Promise<RankedHit[]> {
    const seen: RankedHit[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const result = await narsil.query(INDEX, { ...params, limit, searchAfter: cursor })
      seen.push(...result.hits.map(hit => ({ id: hit.id, score: hit.score ?? 0 })))
      cursor = result.cursor
      if (cursor === undefined) return seen
    }
    throw new Error('the cursor never ran out')
  }

  function expectSameOrder(actual: RankedHit[], expected: RankedHit[]): void {
    expect(actual.map(hit => hit.id)).toEqual(expected.map(hit => hit.id))
    for (const [i, hit] of actual.entries()) expect(hit.score).toBeCloseTo(expected[i].score, 9)
  }

  it.each<[string, QueryParams, string]>([
    ['keyword', { term: 'river stone', termMatch: 'any' }, 'river stone'],
    ['vector', { vector: { field: 'embedding', value: Array.from(letterEmbedding('quiet harbor')) } }, 'quiet harbor'],
  ])('reorders a %s query as the oracle does, on every cursor page', async (_mode, base, queryText) => {
    const reranker = recordingReranker()
    narsil.registerRerankAdapter('overlap', reranker)
    const fields = ['title', 'tags', 'summary']
    const rerank = { adapter: 'overlap', fields, query: queryText, window: 12 }

    const expected = oracleOrder(await firstStage(base), 12, queryText, fields)
    const walked = await walkPages({ ...base, rerank }, 5)

    expectSameOrder(walked, expected)
    expect(reranker.calls.every(call => call.query === queryText && call.documents.length === 12)).toBe(true)
    const plain = await narsil.query(INDEX, { ...base, limit: 3, facets: { category: {} } })
    const reranked = await narsil.query(INDEX, { ...base, limit: 3, facets: { category: {} }, rerank })
    expect(reranked.count).toBe(plain.count)
    expect(reranked.countExact).toBe(plain.countExact)
    expect(reranked.facets).toEqual(plain.facets)
  })

  it('pages by offset to the same order the cursor walk returns, and scales the tail below every reranked hit', async () => {
    narsil.registerRerankAdapter('overlap', recordingReranker())
    const base: QueryParams = { term: 'north light cedar', termMatch: 'any' }
    const rerank = { adapter: 'overlap', fields: ['title'], window: 8 }
    const expected = oracleOrder(await firstStage(base), 8, 'north light cedar', ['title'])

    const byOffset: RankedHit[] = []
    for (let offset = 0; offset < expected.length; offset += 7) {
      const page = await narsil.query(INDEX, { ...base, rerank, offset, limit: 7 })
      byOffset.push(...page.hits.map(hit => ({ id: hit.id, score: hit.score ?? 0 })))
    }

    expectSameOrder(byOffset, expected)
    const lowestReranked = Math.min(...byOffset.slice(0, 8).map(hit => hit.score))
    expect(byOffset.slice(8).every(hit => hit.score <= lowestReranked)).toBe(true)
  })

  it('breaks a tie between adapter scores by document ID in code point order', async () => {
    narsil.registerRerankAdapter(
      'flat',
      recordingReranker(() => 1),
    )
    const result = await narsil.query(INDEX, {
      term: 'storm',
      rerank: { adapter: 'flat', fields: ['title'], window: 50 },
      limit: 50,
    })
    const ids = result.hits.map(hit => hit.id)
    expect(ids).toEqual([...ids].sort(compareCodePointOrder))
  })

  it('places pinned documents into the reranked order and continues the cursor after the last organic hit', async () => {
    narsil.registerRerankAdapter('overlap', recordingReranker())
    const outside = documents.find(document => !document.title.includes('river') && !document.tags.includes('river'))
    expect(outside).toBeDefined()
    const outsideId = (outside as CorpusDocument).id
    const base: QueryParams = { term: 'river' }
    const rerank = { adapter: 'overlap', fields: ['title', 'tags'], window: 10 }
    const expected = oracleOrder(await firstStage(base), 10, 'river', ['title', 'tags'])
    const insideId = expected[6].id
    const pinned = [
      { docId: outsideId, position: 1 },
      { docId: insideId, position: 3 },
    ]

    const first = await narsil.query(INDEX, { ...base, rerank, pinned, limit: 5 })
    const withPins = expected.filter(hit => hit.id !== insideId).map(hit => hit.id)
    withPins.splice(1, 0, outsideId)
    withPins.splice(3, 0, insideId)
    expect(first.hits.map(hit => hit.id)).toEqual(withPins.slice(0, 5))

    const second = await narsil.query(INDEX, { ...base, rerank, pinned, limit: 5, searchAfter: first.cursor })
    const lastOrganic = first.hits.map(hit => hit.id).filter(id => id !== outsideId && id !== insideId)
    const resumeAt = expected.findIndex(hit => hit.id === lastOrganic[lastOrganic.length - 1]) + 1
    expect(second.hits.map(hit => hit.id)).toEqual(expected.slice(resumeAt, resumeAt + 5).map(hit => hit.id))
  })

  it('counts a pin from outside the matches as the query without rerank does, on the first page alone', async () => {
    narsil.registerRerankAdapter('overlap', recordingReranker())
    const outside = documents.find(document => !document.title.includes('river') && !document.tags.includes('river'))
    const base: QueryParams = { term: 'river' }
    const pinned = [
      { docId: (outside as CorpusDocument).id, position: 0 },
      { docId: 'never-stored', position: 2 },
    ]
    const rerank = { adapter: 'overlap', fields: ['title'], window: 5 }
    const matches = (await narsil.query(INDEX, base)).count

    const first = await narsil.query(INDEX, { ...base, rerank, pinned, limit: 4 })
    const second = await narsil.query(INDEX, { ...base, rerank, pinned, limit: 4, searchAfter: first.cursor })

    expect([first.count, first.countExact]).toEqual([matches + 1, true])
    expect([second.count, second.countExact]).toEqual([matches, true])
  })

  it('reranks against vector.text where the query gives neither rerank.query nor a term', async () => {
    const reranker = recordingReranker()
    narsil.registerRerankAdapter('overlap', reranker)
    await narsil.query(INDEX, {
      vector: { field: 'embedding', text: 'ember storm' },
      rerank: { adapter: 'overlap', fields: ['title'], window: 3 },
      limit: 2,
    })
    expect(reranker.calls.map(call => call.query)).toEqual(['ember storm'])
  })

  it('sends the adapter one line for each string, each list member, and nothing for a missing field', async () => {
    const reranker = recordingReranker()
    narsil.registerRerankAdapter('overlap', reranker)
    await narsil.insert(INDEX, { title: 'zebra one', tags: ['zebra two', 'zebra three'], category: 'alpha' }, 'zebra')
    await narsil.query(INDEX, {
      term: 'zebra',
      rerank: { adapter: 'overlap', fields: ['summary', 'tags', 'title'], window: 1 },
    })
    expect(reranker.calls[0].documents).toEqual(['zebra two\nzebra three\nzebra one'])
  })

  it('keeps the groups, documents, and highlights of the page', async () => {
    narsil.registerRerankAdapter('overlap', recordingReranker())
    const base: QueryParams = { term: 'quiet', group: { fields: ['category'] } }
    const plain = await narsil.query(INDEX, base)
    const result = await narsil.query(INDEX, {
      ...base,
      rerank: { adapter: 'overlap', fields: ['title'] },
      highlight: { fields: ['title'] },
      document: { include: ['title'] },
    })
    expect(result.groups).toEqual(
      plain.groups?.map(group => ({
        ...group,
        hits: group.hits.map(hit => ({ ...hit, document: { title: byId.get(hit.id)?.title } })),
      })),
    )
    for (const hit of result.hits) {
      expect(hit.document).toEqual({ title: byId.get(hit.id)?.title })
      expect(hit.highlights?.title?.snippet).toContain('quiet')
    }
  })

  it('calls no adapter where the page or the window holds no hit', async () => {
    const reranker = recordingReranker()
    narsil.registerRerankAdapter('overlap', reranker)
    const rerank = { adapter: 'overlap', fields: ['title'] }
    const empty = await narsil.query(INDEX, { term: 'nonexistentword', rerank })
    const pastEnd = await narsil.query(INDEX, { term: 'river', rerank, offset: 5_000 })
    const zero = await narsil.query(INDEX, { term: 'river', rerank, limit: 0 })
    expect([empty.hits, pastEnd.hits, zero.hits]).toEqual([[], [], []])
    expect(reranker.calls).toHaveLength(0)
  })

  it.each<[string, () => RerankAdapter]>([
    [
      'throws',
      () => ({
        async rerank() {
          throw new Error('model offline')
        },
      }),
    ],
    [
      'throws a NarsilError of its own',
      () => ({
        async rerank() {
          throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'the API key function returned nothing')
        },
      }),
    ],
    ['returns too few scores', () => ({ rerank: async () => [1] })],
    [
      'returns a score that is not finite',
      () => ({ rerank: async (_q, documents) => documents.map(() => Number.NaN) }),
    ],
    ['returns no list', () => ({ rerank: async () => 'scores' as unknown as number[] })],
  ])('raises RERANK_FAILED where the adapter %s', async (_label, adapter) => {
    narsil.registerRerankAdapter('broken', adapter())
    const failure = await failureOf(
      narsil.query(INDEX, { term: 'river', rerank: { adapter: 'broken', fields: ['title'], window: 5 } }),
    )
    expect(failure.code).toBe(ErrorCodes.RERANK_FAILED)
  })

  it('cancels an adapter that outlasts rerankTimeout and raises RERANK_FAILED', async () => {
    await narsil.shutdown()
    narsil = await createNarsil({ workers: { enabled: false }, rerankTimeout: 50 })
    await narsil.createIndex(INDEX, corpusIndex)
    for (const document of documents.slice(0, 10)) await narsil.insert(INDEX, stored(document), document.id)
    let signal: AbortSignal | undefined
    narsil.registerRerankAdapter('slow', {
      rerank(_query, _documents, cancel) {
        signal = cancel
        return new Promise(() => undefined)
      },
    })
    const started = Date.now()
    const failure = await failureOf(
      narsil.query(INDEX, {
        term: 'river stone light',
        termMatch: 'any',
        rerank: { adapter: 'slow', fields: ['title'] },
      }),
    )
    expect(failure.code).toBe(ErrorCodes.RERANK_FAILED)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(signal?.aborted).toBe(true)
  })

  it.each<[string, QueryParams['rerank'], string]>([
    ['an unregistered adapter', { adapter: 'missing', fields: ['title'] }, ErrorCodes.RERANK_CONFIG_INVALID],
    ['no fields', { adapter: 'overlap', fields: [] }, ErrorCodes.RERANK_CONFIG_INVALID],
    ['a field the schema lacks', { adapter: 'overlap', fields: ['body'] }, ErrorCodes.RERANK_CONFIG_INVALID],
    ['a field that is not text', { adapter: 'overlap', fields: ['category'] }, ErrorCodes.RERANK_CONFIG_INVALID],
    [
      'a field given twice',
      { adapter: 'overlap', fields: ['title', 'tags', 'title'] },
      ErrorCodes.RERANK_CONFIG_INVALID,
    ],
    ['a prototype key as a field', { adapter: 'overlap', fields: ['__proto__'] }, ErrorCodes.RERANK_CONFIG_INVALID],
    ['a window of zero', { adapter: 'overlap', fields: ['title'], window: 0 }, ErrorCodes.RERANK_CONFIG_INVALID],
    [
      'a window past maxRerankWindow',
      { adapter: 'overlap', fields: ['title'], window: 101 },
      ErrorCodes.RERANK_CONFIG_INVALID,
    ],
    ['a fractional window', { adapter: 'overlap', fields: ['title'], window: 2.5 }, ErrorCodes.RERANK_CONFIG_INVALID],
    ['a blank query', { adapter: 'overlap', fields: ['title'], query: '   ' }, ErrorCodes.RERANK_CONFIG_INVALID],
    ['an empty adapter name', { adapter: '', fields: ['title'] }, ErrorCodes.RERANK_CONFIG_INVALID],
    ['null', null as unknown as QueryParams['rerank'], ErrorCodes.RERANK_CONFIG_INVALID],
    ['a string', 'overlap' as unknown as QueryParams['rerank'], ErrorCodes.RERANK_CONFIG_INVALID],
  ])('refuses a rerank with %s', async (_label, rerank, code) => {
    const reranker = recordingReranker()
    narsil.registerRerankAdapter('overlap', reranker)
    const failure = await failureOf(narsil.query(INDEX, { term: 'river', rerank }))
    expect(failure.code).toBe(code)
    expect(reranker.calls).toHaveLength(0)
  })

  it('refuses a reranked query without query text, a sort, or a page past the result window', async () => {
    narsil.registerRerankAdapter('overlap', recordingReranker())
    const rerank = { adapter: 'overlap', fields: ['title'] }
    const noText = await failureOf(narsil.query(INDEX, { vector: { field: 'embedding', value: [1, 0, 0] }, rerank }))
    const sorted = await failureOf(narsil.query(INDEX, { term: 'river', sort: { title: 'asc' }, rerank }))
    const deep = await failureOf(narsil.query(INDEX, { term: 'river', offset: 9_995, limit: 10, rerank }))
    expect([noText.code, sorted.code, deep.code]).toEqual([
      ErrorCodes.RERANK_CONFIG_INVALID,
      ErrorCodes.SEARCH_INVALID_MODE,
      ErrorCodes.SEARCH_RESULT_WINDOW_EXCEEDED,
    ])
  })

  it('refuses a cursor from the same query without rerank, or with another rerank', async () => {
    narsil.registerRerankAdapter('overlap', recordingReranker())
    const rerank = { adapter: 'overlap', fields: ['title'] }
    const plain = await narsil.query(INDEX, { term: 'river', limit: 2 })
    const reranked = await narsil.query(INDEX, { term: 'river', limit: 2, rerank })
    const crossed = await failureOf(narsil.query(INDEX, { term: 'river', limit: 2, rerank, searchAfter: plain.cursor }))
    const changed = await failureOf(
      narsil.query(INDEX, { term: 'river', limit: 2, rerank: { ...rerank, window: 5 }, searchAfter: reranked.cursor }),
    )
    const dropped = await failureOf(narsil.query(INDEX, { term: 'river', limit: 2, searchAfter: reranked.cursor }))
    expect([crossed.code, changed.code, dropped.code]).toEqual([
      ErrorCodes.SEARCH_INVALID_CURSOR,
      ErrorCodes.SEARCH_INVALID_CURSOR,
      ErrorCodes.SEARCH_INVALID_CURSOR,
    ])
  })

  it('refuses rerank settings outside their ranges', async () => {
    for (const config of [
      { maxRerankWindow: 0 },
      { maxRerankWindow: 1_001 },
      { rerankTimeout: 0 },
      { rerankTimeout: 1.5 },
    ]) {
      await expect(createNarsil({ workers: { enabled: false }, ...config })).rejects.toMatchObject({
        code: ErrorCodes.CONFIG_INVALID,
      })
    }
  })

  it('allows a window up to a raised maxRerankWindow', async () => {
    await narsil.shutdown()
    narsil = await createNarsil({ workers: { enabled: false }, maxRerankWindow: 300 })
    await narsil.createIndex(INDEX, corpusIndex)
    for (const document of documents) await narsil.insert(INDEX, stored(document), document.id)
    const reranker = recordingReranker()
    narsil.registerRerankAdapter('overlap', reranker)
    await narsil.query(INDEX, {
      term: 'river stone light north',
      termMatch: 'any',
      rerank: { adapter: 'overlap', fields: ['title'], window: 300 },
    })
    expect(reranker.calls[0].documents.length).toBeGreaterThan(0)
    const failure = await failureOf(
      narsil.query(INDEX, { term: 'river', rerank: { adapter: 'overlap', fields: ['title'], window: 301 } }),
    )
    expect(failure.code).toBe(ErrorCodes.RERANK_CONFIG_INVALID)
  })
})
