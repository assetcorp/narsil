import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { AnyDocument } from '../../types/schema'
import { type NativeOperation, observeFallbacks, setNativeSearchCoreEnabled } from '../../vector/native/backend'
import { INDEX, PROBE_TERMS, registerWorkshopLanguage, workshopCorpus } from '../e2e/partial-words/corpus'
import { expectSameHits, hitsOf, NO_WORKERS, RESULT_LIMIT, WORKSHOP_INDEX_CONFIG } from '../e2e/partial-words/harness'
import { createOracle, type Oracle, type OracleHit, type OracleQuery } from '../e2e/partial-words/oracle'
import { backends, searchWithTheHostBinary } from './removed-vectors/fixtures'

const DOCUMENTS = 1_600
const SCORE_TOLERANCE = 1e-9
const MIN_SEARCHES_DURING_REMOVALS = 10
const CONCURRENT_SEARCHERS = 8
const MAX_SEARCHES_PER_REMOVAL = CONCURRENT_SEARCHERS * 2
const STREAMED_REMOVAL_EVERY = 80
const STORAGES = ['memory', 'disk'] as const
const BOUNDED_CASES = [
  { storage: 'memory', mode: 'async', removedEvery: 80 },
  { storage: 'disk', mode: 'async', removedEvery: 80 },
  { storage: 'disk', mode: 'sync', removedEvery: 80 },
] as const
const SHAPES: readonly Omit<OracleQuery, 'term'>[] = [
  { partialWords: true },
  { partialWords: true, prefix: true },
  { partialWords: false },
  { partialWords: false, termMatch: 'all' },
]
const QUERIES: readonly OracleQuery[] = PROBE_TERMS.flatMap(term => SHAPES.map(shape => ({ term, ...shape })))

let directory: string | null = null
let restoredDirectory: string | null = null
let engine: Narsil | null = null

searchWithTheHostBinary()

beforeAll(() => {
  registerWorkshopLanguage()
})

afterEach(async () => {
  await engine?.shutdown()
  engine = null
  for (const held of [directory, restoredDirectory]) if (held !== null) await rm(held, { recursive: true, force: true })
  directory = null
  restoredDirectory = null
})

async function openFrozen(
  storage: (typeof STORAGES)[number],
  documents: readonly AnyDocument[],
  mode: 'sync' | 'async' = 'sync',
): Promise<Narsil> {
  directory = await mkdtemp(join(tmpdir(), 'narsil-frozen-settling-'))
  const writer = await createNarsil({ durability: { directory }, workers: NO_WORKERS })
  await writer.createIndex(INDEX, { ...WORKSHOP_INDEX_CONFIG, textStorage: storage })
  expect((await writer.insertBatch(INDEX, [...documents])).failed).toEqual([])
  await writer.checkpoint(INDEX)
  await writer.shutdown()
  engine = await createNarsil({ durability: { directory, mode }, workers: NO_WORKERS })
  return engine
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

async function search(narsil: Narsil, query: OracleQuery): Promise<OracleHit[]> {
  return hitsOf(await narsil.query(INDEX, { ...query, limit: RESULT_LIMIT }))
}

function sameHits(found: readonly OracleHit[], expected: readonly OracleHit[]): boolean {
  if (found.length !== expected.length) return false
  const scores = new Map(expected.map(hit => [hit.id, hit.score]))
  return found.every(hit => {
    const score = scores.get(hit.id)
    return score !== undefined && Math.abs(hit.score - score) <= SCORE_TOLERANCE * Math.max(1, Math.abs(score))
  })
}

async function expectEveryQuery(narsil: Narsil, held: readonly AnyDocument[], label: string): Promise<void> {
  const oracle = createOracle(held)
  for (const query of QUERIES)
    expectSameHits(await search(narsil, query), oracle.search(query), `${label} ${JSON.stringify(query)}`)
}

interface ObservedSearch {
  query: OracleQuery
  before: number
  after: number
  hits: OracleHit[]
}

describe.each(backends)('frozen removals settle before every read through $name', ({ native, available }) => {
  const fallbacks: NativeOperation[] = []

  beforeEach(() => {
    setNativeSearchCoreEnabled(native)
    fallbacks.length = 0
    observeFallbacks(operation => fallbacks.push(operation))
  })

  afterEach(() => {
    observeFallbacks(null)
    setNativeSearchCoreEnabled(true)
  })

  it.skipIf(!available).each(STORAGES)(
    'searches complete and match the oracle while removals stream into a %s segment',
    async storage => {
      const documents = workshopCorpus(DOCUMENTS, 53)
      const narsil = await openFrozen(storage, documents)
      const leaving = documents
        .filter((_, at) => at % STREAMED_REMOVAL_EVERY === 0)
        .map(document => String(document.id))
      let removed = 0
      let streaming = true
      const removals = (async () => {
        try {
          for (const docId of leaving) {
            await narsil.remove(INDEX, docId)
            removed++
          }
        } finally {
          streaming = false
        }
      })()
      const observed: ObservedSearch[] = []
      const searches = (async () => {
        for (let at = 0; streaming; at++) {
          const query = QUERIES[at % QUERIES.length]
          const before = removed
          const hits = await search(narsil, query)
          observed.push({ query, before, after: removed, hits })
          await nextEventLoopTurn()
        }
      })()
      await Promise.all([removals, searches])

      const oracles = new Map<number, Oracle>()
      const oracleAt = (count: number): Oracle => {
        let oracle = oracles.get(count)
        if (oracle === undefined) {
          const gone = new Set(leaving.slice(0, count))
          oracle = createOracle(documents.filter(document => !gone.has(String(document.id))))
          oracles.set(count, oracle)
        }
        return oracle
      }
      for (const { query, before, after, hits } of observed) {
        for (const count of oracles.keys()) if (count < before) oracles.delete(count)
        const last = Math.min(after + 1, leaving.length)
        let matched = false
        for (let count = before; count <= last && !matched; count++)
          matched = sameHits(hits, oracleAt(count).search(query))
        if (!matched)
          expectSameHits(
            hits,
            oracleAt(after).search(query),
            `after ${before} to ${last} removals ${JSON.stringify(query)}`,
          )
      }
      expect(observed.filter(search => search.after < leaving.length).length).toBeGreaterThanOrEqual(
        MIN_SEARCHES_DURING_REMOVALS,
      )
      const gone = new Set(leaving)
      await expectEveryQuery(
        narsil,
        documents.filter(document => !gone.has(String(document.id))),
        'after the stream',
      )
      expect(fallbacks).not.toContain('removeFrozenDocument')
    },
    180_000,
  )

  it.skipIf(!available).each(STORAGES)(
    'a removal batch that fills the pending regions of a %s segment settles and keeps every score',
    async storage => {
      const documents = workshopCorpus(DOCUMENTS, 59)
      const narsil = await openFrozen(storage, documents)
      const leaving = documents.filter((_, at) => at % 2 === 0).map(document => String(document.id))
      expect((await narsil.removeBatch(INDEX, leaving)).failed).toEqual([])
      const gone = new Set(leaving)
      const held = documents.filter(document => !gone.has(String(document.id)))
      await expectEveryQuery(narsil, held, 'after the batch')
      expect(await narsil.countDocuments(INDEX)).toBe(held.length)

      restoredDirectory = await mkdtemp(join(tmpdir(), 'narsil-frozen-settling-restored-'))
      const restored = await createNarsil({ durability: { directory: restoredDirectory }, workers: NO_WORKERS })
      try {
        await restored.restore(INDEX, await narsil.snapshot(INDEX))
        await expectEveryQuery(restored, held, 'restored from a snapshot')
      } finally {
        await restored.shutdown()
      }

      await narsil.shutdown()
      engine = await createNarsil({ durability: { directory: directory ?? '' }, workers: NO_WORKERS })
      await expectEveryQuery(engine, held, 'reopened')
      const more = held.filter((_, at) => at % 2 === 0).map(document => String(document.id))
      expect((await engine.removeBatch(INDEX, more)).failed).toEqual([])
      const kept = new Set(more)
      await expectEveryQuery(
        engine,
        held.filter(document => !kept.has(String(document.id))),
        'removed half of the reopened index',
      )
    },
    180_000,
  )

  it.skipIf(!available).each(BOUNDED_CASES)(
    'every removal from a $storage segment with $mode flushes finishes while searches keep arriving',
    async ({ storage, mode, removedEvery }) => {
      const documents = workshopCorpus(DOCUMENTS, 61)
      const narsil = await openFrozen(storage, documents, mode)
      const leaving = documents.filter((_, at) => at % removedEvery === 0).map(document => String(document.id))
      await narsil.remove(INDEX, leaving[0])
      let removal = -1
      let open = false
      let streaming = true
      const overtaking: number[] = []
      const searchers = Array.from({ length: CONCURRENT_SEARCHERS }, async (_, searcher) => {
        for (let at = searcher; streaming; at += CONCURRENT_SEARCHERS) {
          const issuedDuring = open ? removal : -1
          await search(narsil, QUERIES[at % QUERIES.length])
          if (open && issuedDuring === removal) overtaking[removal]++
          await nextEventLoopTurn()
        }
      })
      try {
        await nextEventLoopTurn()
        for (const docId of leaving.slice(1)) {
          removal++
          overtaking.push(0)
          open = true
          await narsil.remove(INDEX, docId)
          open = false
          await nextEventLoopTurn()
        }
      } finally {
        open = false
        streaming = false
        await Promise.all(searchers)
      }
      expect(overtaking).toHaveLength(leaving.length - 1)
      if (mode === 'async') expect(Math.max(...overtaking)).toBeLessThanOrEqual(MAX_SEARCHES_PER_REMOVAL)
      expect(overtaking.filter(count => count > 0).length).toBeGreaterThanOrEqual(MIN_SEARCHES_DURING_REMOVALS)
      const gone = new Set(leaving)
      await expectEveryQuery(
        narsil,
        documents.filter(document => !gone.has(String(document.id))),
        'after removals under concurrent searches',
      )
    },
    180_000,
  )
})
