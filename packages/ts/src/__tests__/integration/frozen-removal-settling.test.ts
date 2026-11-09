import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilPlugin } from '../../types/plugins'
import type { AnyDocument } from '../../types/schema'
import { type NativeOperation, observeFallbacks, setNativeSearchCoreEnabled } from '../../vector/native/backend'
import { INDEX, PROBE_TERMS, registerWorkshopLanguage, workshopCorpus } from '../e2e/partial-words/corpus'
import { expectSameHits, hitsOf, NO_WORKERS, RESULT_LIMIT, WORKSHOP_INDEX_CONFIG } from '../e2e/partial-words/harness'
import { createOracle, type Oracle, type OracleHit, type OracleQuery } from '../e2e/partial-words/oracle'
import { backends, searchWithTheHostBinary } from './removed-vectors/fixtures'
import { createSearchHold, type SearchHold } from './search-hold'

const DOCUMENTS = 1_600
const SCORE_TOLERANCE = 1e-9
const SEARCHES_PER_REMOVAL = 8
const STREAMED_REMOVAL_EVERY = 80
const STORAGES = ['memory', 'disk'] as const
const FLUSH_CASES = [
  { storage: 'memory', mode: 'sync' },
  { storage: 'memory', mode: 'async' },
  { storage: 'disk', mode: 'async' },
  { storage: 'disk', mode: 'sync' },
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
  plugins: NarsilPlugin[] = [],
): Promise<Narsil> {
  directory = await mkdtemp(join(tmpdir(), 'narsil-frozen-settling-'))
  const writer = await createNarsil({ durability: { directory }, workers: NO_WORKERS })
  await writer.createIndex(INDEX, { ...WORKSHOP_INDEX_CONFIG, textStorage: storage })
  expect((await writer.insertBatch(INDEX, [...documents])).failed).toEqual([])
  await writer.checkpoint(INDEX)
  await writer.shutdown()
  engine = await createNarsil({ durability: { directory, mode }, workers: NO_WORKERS, plugins })
  return engine
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
  removal: number
  hits: OracleHit[]
}

async function removeUnderHeldSearches(narsil: Narsil, hold: SearchHold, leaving: readonly string[]) {
  const observed: ObservedSearch[] = []
  for (let removal = 0; removal < leaving.length; removal++) {
    const reached = hold.hold(SEARCHES_PER_REMOVAL)
    const searches = Array.from({ length: SEARCHES_PER_REMOVAL }, async (_, at) => {
      const query = QUERIES[(removal * SEARCHES_PER_REMOVAL + at) % QUERIES.length]
      return { query, removal, hits: await search(narsil, query) }
    })
    const answered = Promise.all(searches)
    await Promise.race([reached, answered])
    const removed = narsil.remove(INDEX, leaving[removal])
    hold.release()
    const [answers] = await Promise.all([answered, removed])
    observed.push(...answers)
  }
  return observed
}

function expectEachAnswerBesideItsRemoval(
  observed: readonly ObservedSearch[],
  documents: readonly AnyDocument[],
  leaving: readonly string[],
): void {
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
  for (const { query, removal, hits } of observed) {
    if (sameHits(hits, oracleAt(removal).search(query))) continue
    expectSameHits(
      hits,
      oracleAt(removal + 1).search(query),
      `beside removal ${removal + 1} of ${leaving.length} ${JSON.stringify(query)}`,
    )
  }
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

  it.skipIf(!available).each(FLUSH_CASES)(
    'every search beside a removal from a $storage segment with $mode flushes matches the index before or after it',
    async ({ storage, mode }) => {
      const documents = workshopCorpus(DOCUMENTS, 61)
      const hold = createSearchHold()
      const narsil = await openFrozen(storage, documents, mode, [hold.plugin])
      const leaving = documents
        .filter((_, at) => at % STREAMED_REMOVAL_EVERY === 0)
        .map(document => String(document.id))
      const observed = await removeUnderHeldSearches(narsil, hold, leaving)
      expect(observed).toHaveLength(leaving.length * SEARCHES_PER_REMOVAL)
      expectEachAnswerBesideItsRemoval(observed, documents, leaving)
      const gone = new Set(leaving)
      await expectEveryQuery(
        narsil,
        documents.filter(document => !gone.has(String(document.id))),
        'after removals beside held searches',
      )
      expect(fallbacks).not.toContain('removeFrozenDocument')
    },
    180_000,
  )
})
