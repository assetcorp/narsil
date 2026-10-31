import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { BM25Params } from '../../../types/schema'
import { INDEX, registerPantryLanguage } from './corpus'
import { expectSameHits, hitsOf, NO_WORKERS, PANTRY_CONFIG, type PantryServer, startPantryServer } from './harness'

const DOCUMENTS = [
  { id: 'kitchen', title: 'olive oil', body: 'salt pasta bread', tags: [], shelf: 1 },
  { id: 'market', title: 'salt bread', body: 'olive oil olive oil salt pasta', tags: [], shelf: 2 },
  { id: 'bakery', title: 'fresh bread', body: 'olive bread', tags: [], shelf: 3 },
  { id: 'deli', title: 'salt', body: 'pasta oil olive', tags: [], shelf: 4 },
]

const OLIVE_IDF = Math.log(0.5 / 4.5 + 1)
const OIL_IDF = Math.log(1.5 / 3.5 + 1)
const PASTA_IDF = Math.log(1.5 / 3.5 + 1)
const PHRASE_IDF = OLIVE_IDF + OIL_IDF
const AVERAGE_TITLE_LENGTH = 7 / 4
const AVERAGE_BODY_LENGTH = 14 / 4

interface Pair {
  k1: number
  b: number
}

function handScore(idf: number, frequency: number, length: number, average: number, { k1, b }: Pair): number {
  return (idf * frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * length) / average))
}

function expectedHits(title: Pair, body: Pair) {
  return [
    {
      id: 'kitchen',
      score:
        handScore(PHRASE_IDF, 1, 2, AVERAGE_TITLE_LENGTH, title) +
        handScore(PASTA_IDF, 1, 3, AVERAGE_BODY_LENGTH, body),
    },
    {
      id: 'market',
      score:
        handScore(PHRASE_IDF, 2, 6, AVERAGE_BODY_LENGTH, body) + handScore(PASTA_IDF, 1, 6, AVERAGE_BODY_LENGTH, body),
    },
  ]
}

const INDEX_SETTING: BM25Params = { k1: 0.5, b: 0.9, fields: { body: { k1: 2 } } }
const LEVELS: ReadonlyArray<{ label: string; search?: BM25Params; title: Pair; body: Pair }> = [
  { label: 'the index setting', title: { k1: 0.5, b: 0.9 }, body: { k1: 2, b: 0.9 } },
  { label: 'a search pair', search: { k1: 0.7, b: 0.2 }, title: { k1: 0.7, b: 0.2 }, body: { k1: 0.7, b: 0.2 } },
  {
    label: 'a search pair and search values for each field',
    search: { b: 0.3, fields: { title: { k1: 3 }, body: { b: 1 } } },
    title: { k1: 3, b: 0.3 },
    body: { k1: 2, b: 1 },
  },
]

let server: PantryServer | null = null

beforeAll(() => {
  registerPantryLanguage()
})

afterEach(async () => {
  await server?.stop()
  server = null
})

describe('a quoted query scores under the BM25 pair of each field', () => {
  it('matches a hand-computed score at the index level, the search level, and the field level', async () => {
    server = await startPantryServer({ workers: NO_WORKERS })
    await server.client.createIndex(INDEX, { ...PANTRY_CONFIG, bm25: INDEX_SETTING })
    expect((await server.client.insertBatch(INDEX, DOCUMENTS)).failed).toEqual([])
    await server.client.waitForWrites(INDEX)

    for (const { label, search, title, body } of LEVELS) {
      const params = { term: '"olive oil" pasta', limit: 10, ...(search === undefined ? {} : { bm25: search }) }
      const expected = expectedHits(title, body)
      expectSameHits(hitsOf(await server.engine.query(INDEX, params)), expected, `API under ${label}`)
      expectSameHits(hitsOf(await server.client.query(INDEX, params)), expected, `HTTP under ${label}`)
    }
  })
})
