import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { LIVE_TAIL_FREEZE_FLOOR } from '../../../engine/orchestration/constants'
import type { AnyDocument } from '../../../types/schema'
import { INDEX, registerWorkshopLanguage, TEXT_FIELDS } from './corpus'
import {
  createWorkshopIndex,
  expectSameHits,
  insertAll,
  searchOver,
  startWorkshopServer,
  WORKERS_BUILT,
  type WorkshopServer,
  waitForWorkerCopies,
  workerCopies,
} from './harness'
import { createOracle, inCodePointOrder, type OracleQuery } from './oracle'

const LETTERS_WITHOUT_S = 'abcdefghijklmnopqrtuvwxyz'
const GOTHIC_AHSA = '\u{10330}'
const GOTHIC_BAIRKAN = '\u{10331}'
const WORD_SPREAD_ACROSS_BOTH_PARTS = 'canal'
const ASTRAL_WORD = `ca${GOTHIC_AHSA}${GOTHIC_BAIRKAN}`
const FROZEN_WORDS = wordsStartingWith('caf', 60)
const TAIL_WORDS = wordsStartingWith('cab', 55)

const FROZEN_DOCUMENTS: AnyDocument[] = [
  ...titled('frozen-rare', 5, FROZEN_WORDS.join(' ')),
  ...titled('frozen-canal', 4, WORD_SPREAD_ACROSS_BOTH_PARTS),
  ...titled('frozen-astral', 6, ASTRAL_WORD),
  ...titled('frozen-filler', 225, 'lamp chair'),
]
const TAIL_DOCUMENTS: AnyDocument[] = [
  ...titled('tail-rare', 10, TAIL_WORDS.join(' ')),
  ...titled('tail-canal', 10, WORD_SPREAD_ACROSS_BOTH_PARTS),
  ...titled('tail-astral', 6, ASTRAL_WORD),
]
const DOCUMENTS = [...FROZEN_DOCUMENTS, ...TAIL_DOCUMENTS]

const PREFIX_QUERIES: readonly OracleQuery[] = [
  { term: 'ca', prefix: true },
  { term: 'ca', prefix: true, fields: ['title'] },
  { term: 'lamp ca', prefix: true },
  { term: `ca${GOTHIC_AHSA}`, prefix: true },
]

function wordsStartingWith(start: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, at) =>
      `${start}${LETTERS_WITHOUT_S[Math.floor(at / LETTERS_WITHOUT_S.length)]}${LETTERS_WITHOUT_S[at % LETTERS_WITHOUT_S.length]}`,
  )
}

function titled(idPrefix: string, count: number, title: string): AnyDocument[] {
  return Array.from({ length: count }, (_, at) => ({
    id: `${idPrefix}-${String(at).padStart(3, '0')}`,
    title,
    body: 'bench table',
  }))
}

function wordsByDocumentCount(
  documents: readonly AnyDocument[],
  prefix: string,
): Array<{ term: string; documentFrequency: number }> {
  const counts = new Map<string, number>()
  for (const document of documents) {
    const words = new Set(TEXT_FIELDS.flatMap(field => String(document[field] ?? '').split(' ')))
    for (const word of words) {
      if (word.startsWith(prefix)) counts.set(word, (counts.get(word) ?? 0) + 1)
    }
  }
  return [...counts]
    .map(([term, documentFrequency]) => ({ term, documentFrequency }))
    .sort((left, right) => right.documentFrequency - left.documentFrequency || inCodePointOrder(left.term, right.term))
}

const servers: WorkshopServer[] = []

beforeAll(() => {
  registerWorkshopLanguage()
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

async function indexWithFrozenSegmentAndLiveTail(): Promise<WorkshopServer> {
  expect(TAIL_DOCUMENTS.length).toBeLessThan(LIVE_TAIL_FREEZE_FLOOR)
  const server = await startWorkshopServer({ workers: workerCopies() })
  servers.push(server)
  await createWorkshopIndex(server, FROZEN_DOCUMENTS)
  await waitForWorkerCopies(server)
  await insertAll(server, TAIL_DOCUMENTS)
  await server.client.waitForWrites(INDEX)
  return server
}

describe('completions served over HTTP from worker copies that hold a frozen segment and a live tail', () => {
  it.skipIf(!WORKERS_BUILT)(
    'the engine scores the 50 completions that the most documents contain across both parts, as the oracle does',
    async () => {
      const server = await indexWithFrozenSegmentAndLiveTail()
      const search = searchOver(server.client)
      const oracle = createOracle(DOCUMENTS)
      for (const query of PREFIX_QUERIES) {
        const expected = oracle.search(query)
        expect(expected.length).toBeGreaterThan(0)
        expectSameHits(await search(query), expected, JSON.stringify(query))
      }
    },
    120_000,
  )

  it.skipIf(!WORKERS_BUILT)(
    'the engine ranks each suggestion by the documents that contain it across both parts',
    async () => {
      const server = await indexWithFrozenSegmentAndLiveTail()
      const expected = wordsByDocumentCount(DOCUMENTS, 'ca')
      expect(expected[0]?.term).toBe(WORD_SPREAD_ACROSS_BOTH_PARTS)
      for (const limit of [1, 10]) {
        const suggested = await server.client.suggest(INDEX, { prefix: 'ca', limit })
        expect(suggested.terms, `limit ${limit}`).toEqual(expected.slice(0, limit))
      }
    },
    120_000,
  )
})
