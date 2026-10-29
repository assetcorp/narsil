import { afterEach, describe, expect, it } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../client'
import { ErrorCodes } from '../../errors'
import type { QueryParams } from '../../types/search'
import { type CorpusDocument, corpus, corpusIndex, letterEmbedding, stored } from '../rerank/corpus'
import { cosineOf, oracleRrf, type RankedHit } from '../rerank/oracle'
import { postJson, startTestServer, type TestServer } from './helpers'

const INDEX = 'docs'
const TERM = 'quiet harbor ember'
const vector = { field: 'embedding', value: Array.from(letterEmbedding('cedar')) }

interface ErrorBody {
  error: { code: string; message: string }
}

function ranked(hits: Array<{ id: string; score?: number }>): RankedHit[] {
  return hits.map(hit => ({ id: hit.id, score: hit.score ?? 0 }))
}

describe('hybrid paging over HTTP with the published client', () => {
  let server: TestServer | undefined

  afterEach(async () => {
    await server?.stop()
    server = undefined
  })

  async function seeded(): Promise<{ client: NarsilClient; documents: CorpusDocument[] }> {
    const documents = corpus(140, 53)
    server = await startTestServer({}, { workers: { enabled: false } }, async engine => {
      await engine.createIndex(INDEX, {
        schema: { ...corpusIndex.schema, embedding: 'vector[3]' },
        language: 'english',
      })
      await engine.insertBatch(
        INDEX,
        documents.map(document => ({ ...stored(document), id: document.id })),
      )
    })
    return { client: createNarsilClient({ url: server.base }), documents }
  }

  it('returns the oracle fused order on every cursor page, and answers 400 past the depth', async () => {
    const { client, documents } = await seeded()
    const depth = 24
    const text = await client.query(INDEX, { term: TERM, termMatch: 'any', limit: depth })
    const vectors = await client.query(INDEX, { vector, limit: depth })
    const query = letterEmbedding('cedar')
    const byId = new Map(documents.map(document => [document.id, document]))
    for (const hit of vectors.hits) {
      const document = byId.get(hit.id) as CorpusDocument
      expect(hit.score).toBeCloseTo(cosineOf(letterEmbedding(document.title), query), 5)
    }
    const expected = oracleRrf([ranked(text.hits), ranked(vectors.hits)]).slice(0, depth)

    const params: QueryParams = { term: TERM, termMatch: 'any', vector, hybrid: { depth } }
    const walked: RankedHit[] = []
    let cursor: string | undefined
    do {
      const page = await client.query(INDEX, { ...params, limit: 7, searchAfter: cursor })
      walked.push(...ranked(page.hits))
      cursor = page.cursor
    } while (cursor !== undefined)

    expect(walked.map(hit => hit.id)).toEqual(expected.map(hit => hit.id))
    for (const [i, hit] of walked.entries()) expect(hit.score).toBeCloseTo(expected[i].score, 9)

    const past = await postJson<ErrorBody>(server?.base ?? '', `/indexes/${INDEX}/search`, {
      ...params,
      offset: 24,
      limit: 10,
    })
    expect(past.status).toBe(400)
    expect(past.body.error.code).toBe(ErrorCodes.SEARCH_RESULT_WINDOW_EXCEEDED)
    expect(past.body.error.message).toContain('hybrid.depth')
  })
})
