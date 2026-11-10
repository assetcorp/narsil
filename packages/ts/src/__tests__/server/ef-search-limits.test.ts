import { afterEach, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../client'
import { ErrorCodes } from '../../errors'
import { type CorpusDocument, corpus, corpusIndex, letterEmbedding, stored } from '../rerank/corpus'
import { cosineOf } from '../rerank/oracle'
import { postJson, startTestServer, type TestServer } from './helpers'

const INDEX = 'docs'
const LIMIT = 10
const QUERY_WORD = 'cedar'
const vector = { field: 'embedding', value: Array.from(letterEmbedding(QUERY_WORD)) }

interface ErrorBody {
  error: { code: string; message: string }
}

interface SearchBody {
  hits: Array<{ id: string; score?: number }>
}

function oracleScores(documents: CorpusDocument[]): number[] {
  const query = letterEmbedding(QUERY_WORD)
  return documents
    .map(document => cosineOf(letterEmbedding(document.title), query))
    .sort((left, right) => right - left)
    .slice(0, LIMIT)
}

describe('efSearch and oversample limits over HTTP and in the embedded engine', () => {
  let server: TestServer | undefined

  afterEach(async () => {
    await server?.stop()
    server = undefined
  })

  async function seeded(): Promise<{ running: TestServer; documents: CorpusDocument[] }> {
    const documents = corpus(140, 53)
    const running = await startTestServer({}, { workers: { enabled: false } }, async engine => {
      await engine.createIndex(INDEX, {
        schema: { ...corpusIndex.schema, embedding: 'vector[3]' },
        language: 'english',
      })
      await engine.insertBatch(
        INDEX,
        documents.map(document => ({
          ...stored(document),
          id: document.id,
          embedding: Array.from(letterEmbedding(document.title)),
        })),
      )
    })
    server = running
    return { running, documents }
  }

  it('answers 400 with CONFIG_INVALID for an efSearch outside 1 to 10,000 on vector and hybrid searches', async () => {
    const { running } = await seeded()
    for (const efSearch of [0, 10_001, 1.5, -3]) {
      for (const body of [
        { vector: { ...vector, efSearch }, limit: LIMIT },
        { term: 'quiet harbor', vector: { ...vector, efSearch }, limit: LIMIT },
      ]) {
        const refused = await postJson<ErrorBody>(running.base, `/indexes/${INDEX}/search`, body)
        expect(refused.status, `efSearch ${efSearch}`).toBe(400)
        expect(refused.body.error.code).toBe(ErrorCodes.CONFIG_INVALID)
        expect(refused.body.error.message).toContain('efSearch')
      }
    }
    const client = createNarsilClient({ url: running.base })
    await expect(client.query(INDEX, { vector: { ...vector, efSearch: Number.NaN } })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    })
  })

  it('answers 400 for a bad efSearch or oversample on a field below the promotion threshold and under a filter that matches nothing', async () => {
    const { running } = await seeded()
    const [field] = running.engine.vectorMaintenanceStatus(INDEX)
    expect(field?.graphCount).toBe(0)
    const matchesNothing = { fields: { category: { eq: 'delta' } } }
    const empty = await postJson<SearchBody>(running.base, `/indexes/${INDEX}/search`, {
      vector,
      filters: matchesNothing,
      limit: LIMIT,
    })
    expect(empty.status).toBe(200)
    expect(empty.body.hits).toHaveLength(0)
    for (const option of [{ efSearch: 0 }, { efSearch: 10_001 }, { oversample: 0.5 }, { oversample: -1 }]) {
      for (const filters of [undefined, matchesNothing]) {
        for (const body of [
          { vector: { ...vector, ...option }, filters, limit: LIMIT },
          { term: 'quiet harbor', vector: { ...vector, ...option }, filters, limit: LIMIT },
          { term: 'quiet harbor', vector: { ...vector, ...option }, filters, hybrid: { depth: 50 }, limit: LIMIT },
        ]) {
          const label = `${JSON.stringify(option)} ${filters === undefined ? 'unfiltered' : 'filtered'}`
          const refused = await postJson<ErrorBody>(running.base, `/indexes/${INDEX}/search`, body)
          expect(refused.status, label).toBe(400)
          expect(refused.body.error.code, label).toBe(ErrorCodes.CONFIG_INVALID)
          expect(refused.body.error.message, label).toContain(Object.keys(option)[0])
          await expect(running.engine.preflight(INDEX, body), label).rejects.toMatchObject({
            code: ErrorCodes.CONFIG_INVALID,
          })
        }
      }
    }
  })

  it('refuses NaN and a huge efSearch in the embedded engine before any walk starts', async () => {
    const { running } = await seeded()
    for (const efSearch of [Number.NaN, 1e9, Number.POSITIVE_INFINITY]) {
      await expect(running.engine.query(INDEX, { vector: { ...vector, efSearch } })).rejects.toMatchObject({
        code: ErrorCodes.CONFIG_INVALID,
      })
      await expect(running.engine.preflight(INDEX, { vector: { ...vector, efSearch } })).rejects.toMatchObject({
        code: ErrorCodes.CONFIG_INVALID,
      })
    }
  })

  it('accepts the bounds 1 and 10,000, and 10,000 returns the exact nearest neighbours', async () => {
    const { running, documents } = await seeded()
    const lowest = await postJson<SearchBody>(running.base, `/indexes/${INDEX}/search`, {
      vector: { ...vector, efSearch: 1 },
      limit: LIMIT,
    })
    expect(lowest.status).toBe(200)
    expect(lowest.body.hits).toHaveLength(LIMIT)
    const highest = await postJson<SearchBody>(running.base, `/indexes/${INDEX}/search`, {
      vector: { ...vector, efSearch: 10_000 },
      limit: LIMIT,
    })
    expect(highest.status).toBe(200)
    const scores = highest.body.hits.map(hit => hit.score ?? Number.NaN)
    const wanted = oracleScores(documents)
    expect(scores).toHaveLength(wanted.length)
    for (const [at, score] of scores.entries()) expect(score).toBeCloseTo(wanted[at], 5)
  })
})
