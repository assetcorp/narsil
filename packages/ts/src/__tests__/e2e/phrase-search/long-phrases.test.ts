import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { AnyDocument } from '../../../types/schema'
import { scaledOut, waitFor } from '../../server/helpers'
import { COMMON_TERM, INDEX, SCHEMA } from '../pattern-search/corpus'
import { type PatternServer, startPatternServer, WORKER_COPIES, WORKERS_BUILT } from '../pattern-search/harness'
import { expectServedWhileHostile, timedSearch } from '../pattern-search/hostile'
import { createLongQueryGate, type LongQueryGate } from '../pattern-search/long-query-gate'

const REPEATED_DOCUMENTS = 1_000
const WORD_PAIRS_PER_DOCUMENT = 2_000
const DOCUMENTS_PER_REQUEST = 100
const PARTITIONS = 8
const NORMAL_SKU = 'SKU-NORMAL'
const NORMAL_FILTERS = { fields: { sku: { eq: NORMAL_SKU } } }
const MAX_PHRASES = 32
const LONG_TEST_TIMEOUT_MS = 180_000

function repeatedPairsCorpus(): AnyDocument[] {
  const body = 'olive oil '.repeat(WORD_PAIRS_PER_DOCUMENT)
  const repeated = Array.from({ length: REPEATED_DOCUMENTS }, (_, at) => ({
    id: `repeated-${at}`,
    body,
    line: 'plain',
    sku: `SKU-${at}`,
  }))
  return [...repeated, { id: 'normal', body: COMMON_TERM, line: 'plain', sku: NORMAL_SKU }]
}

function alternatingPhrase(firstWord: 'olive' | 'oil', wordCount: number): string {
  const second = firstWord === 'olive' ? 'oil' : 'olive'
  const words = Array.from({ length: wordCount }, (_, at) => (at % 2 === 0 ? firstWord : second))
  return `"${words.join(' ')}"`
}

function distinctPhrases(count: number): string {
  return Array.from({ length: count }, (_, at) =>
    alternatingPhrase(at % 2 === 0 ? 'olive' : 'oil', 2 + Math.floor(at / 2)),
  ).join(' ')
}

describe.skipIf(!WORKERS_BUILT)('a phrase of common words on a server with worker copies', () => {
  let server: PatternServer
  let gate: LongQueryGate

  beforeAll(async () => {
    gate = createLongQueryGate()
    server = await startPatternServer({ workers: { ...WORKER_COPIES, bootstrapModule: gate.bootstrapModule } })
    await server.client.createIndex(INDEX, { schema: SCHEMA, partitions: { maxPartitions: PARTITIONS } })
    const documents = repeatedPairsCorpus()
    for (let start = 0; start < documents.length; start += DOCUMENTS_PER_REQUEST) {
      const inserted = await server.client.insertBatch(INDEX, documents.slice(start, start + DOCUMENTS_PER_REQUEST))
      expect(inserted.failed).toEqual([])
    }
    await waitFor(() => scaledOut(server.engine, INDEX), LONG_TEST_TIMEOUT_MS)
    expect(server.requestThreads).toBeGreaterThan(0)
  }, LONG_TEST_TIMEOUT_MS)

  afterAll(async () => {
    await server.stop()
    gate.stop()
  })

  it(
    'moves off its request thread, so another search answers first, and it still finds every document',
    async () => {
      const answer = await expectServedWhileHostile(
        server,
        { term: distinctPhrases(2), limit: 10 },
        NORMAL_FILTERS,
        'a long phrase search',
        false,
        gate,
      )
      expect({ status: answer.status, code: answer.code, count: answer.count }).toEqual({
        status: 200,
        code: null,
        count: REPEATED_DOCUMENTS,
      })
    },
    LONG_TEST_TIMEOUT_MS,
  )

  it(
    'stops at the work cap off the request thread, and keeps answering afterwards',
    async () => {
      const answer = await expectServedWhileHostile(
        server,
        { term: distinctPhrases(MAX_PHRASES), limit: 10 },
        NORMAL_FILTERS,
        'phrases past the work cap',
        false,
        gate,
      )
      expect({ status: answer.status, code: answer.code }).toEqual({
        status: 400,
        code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED,
      })
      const after = await timedSearch(server, { term: '"olive oil"', limit: 1 })
      expect({ status: after.status, count: after.count }).toEqual({ status: 200, count: REPEATED_DOCUMENTS })
    },
    LONG_TEST_TIMEOUT_MS,
  )
})

describe('the work cap of a phrase search that reaches worker copies', () => {
  const engines: Narsil[] = []

  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.shutdown()
  })

  it.skipIf(!WORKERS_BUILT)(
    'counts the positions that every copy compares, in a search and in a count',
    async () => {
      const engine = await createNarsil({
        workers: { promotionThreshold: 200, count: 2, mainCopyQueries: 'none' },
        patternWorkCap: 500,
      })
      engines.push(engine)
      await engine.createIndex(INDEX, { schema: { body: 'string' }, partitions: { maxPartitions: 4 } })
      const documents = Array.from({ length: 400 }, (_, at) => ({ id: `d${at}`, body: 'olive oil olive oil' }))
      expect((await engine.insertBatch(INDEX, documents)).failed).toEqual([])
      await waitFor(() => scaledOut(engine, INDEX))
      await engine.waitForWrites(INDEX)
      await expect(engine.query(INDEX, { term: '"olive oil"' })).rejects.toMatchObject({
        code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED,
      })
      await expect(engine.preflight(INDEX, { term: '"olive oil"' })).rejects.toMatchObject({
        code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED,
      })
      expect((await engine.query(INDEX, { term: 'olive oil' })).count).toBe(400)
    },
    LONG_TEST_TIMEOUT_MS,
  )
})
