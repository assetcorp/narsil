import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { observeKeywordScoringPaths } from '../../../core/keyword-score/native'
import { createNarsil, type Narsil } from '../../../narsil'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import { type NativeOperation, observeFallbacks, setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import { seededRandom } from '../../integration/filtered-vectors/library'
import { backendAvailable, searchThrough } from '../../integration/filtered-vectors/search-backend'
import { expectPageOfFullRanking, UNLIMITED } from './ranking'

const SCORED_IN_FULL = 0
const PRUNED = 1
const PRUNED_THEN_FULL = 2
const CORPUS_SIZE = 4000
const RARE_WORDS = 240
const RARE_HOLDERS = 6
const LONG_FIELD_WORDS = 60_000
const TERMS = ['alpha', 'beta', 'gamma', 'delta', 'omega']
const INDEX = 'parity'
const PARTITIONED_INDEX = 'parity-partitioned'
const PARTITION_COUNT = 2
const TIED_PARTITION = 0
const COMMON_PARTITION = 1
const TIED_DOCUMENTS = 40
const COMMON_DOCUMENTS = 400
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193
const TEST_TIMEOUT_MS = 120_000

searchThrough('native')

function rareWord(at: number): string {
  return `rare${String.fromCharCode(97 + (at % 26))}${String.fromCharCode(97 + Math.floor(at / 26))}x`
}

function corpus(): AnyDocument[] {
  const random = seededRandom(20261105)
  const documents: AnyDocument[] = []
  for (let index = 0; index < CORPUS_SIZE; index++) {
    const term = TERMS[index % TERMS.length]
    const rare: string[] = []
    for (let pick = 0; pick < 2; pick++) {
      if (random() < (RARE_WORDS * RARE_HOLDERS) / CORPUS_SIZE / 2)
        rare.push(rareWord(Math.floor(random() * RARE_WORDS)))
    }
    documents.push({
      id: `doc-${String(index).padStart(5, '0')}`,
      title: index % 3 === 0 ? `alpha ${term}` : TERMS[(index + 2) % TERMS.length],
      body: `${`${term} `.repeat((index % 7) + 1)}${rare.join(' ')} ${'filler '.repeat((index % 23) + 1)}`,
      rank: index,
    })
  }
  return documents
}

interface Scored {
  ids: string[]
  scores: Array<number | undefined>
  count: number
  paths: number[]
}

function fnv1a(text: string): number {
  let hash = FNV_OFFSET_BASIS
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, FNV_PRIME)
  return hash >>> 0
}

function idsOnPartition(partition: number, prefix: string, count: number): string[] {
  const ids: string[] = []
  for (let n = 0; ids.length < count; n++) {
    const id = `${prefix}-${n}`
    if (fnv1a(id) % PARTITION_COUNT === partition) ids.push(id)
  }
  return ids
}

async function scoredBy(narsil: Narsil, indexName: string, params: QueryParams, native: boolean): Promise<Scored> {
  setNativeSearchCoreEnabled(native)
  const paths: number[] = []
  observeKeywordScoringPaths(path => paths.push(path))
  try {
    const result = await narsil.query(indexName, params)
    return {
      ids: result.hits.map(hit => hit.id),
      scores: result.hits.map(hit => hit.score),
      count: result.count,
      paths,
    }
  } finally {
    observeKeywordScoringPaths(null)
    setNativeSearchCoreEnabled(true)
  }
}

async function expectBothBackends(
  narsil: Narsil,
  params: QueryParams,
  path: number | readonly number[],
  indexName = INDEX,
): Promise<void> {
  const label = JSON.stringify(params).slice(0, 200)
  const typeScript = await scoredBy(narsil, indexName, params, false)
  const core = await scoredBy(narsil, indexName, params, true)
  expect(core.ids, label).toEqual(typeScript.ids)
  expect(core.count, label).toBe(typeScript.count)
  for (let at = 0; at < core.scores.length; at++) {
    expect(Object.is(core.scores[at], typeScript.scores[at]), `${label} rank ${at}`).toBe(true)
  }
  expect(typeScript.paths, label).toEqual([])
  expect(core.paths.length, label).toBeGreaterThan(0)
  expect(new Set(core.paths), label).toEqual(new Set(typeof path === 'number' ? [path] : path))
  for (const native of [false, true]) {
    setNativeSearchCoreEnabled(native)
    try {
      await expectPageOfFullRanking(narsil, indexName, params, params.boost === undefined ? undefined : UNLIMITED)
    } finally {
      setNativeSearchCoreEnabled(true)
    }
  }
}

describe.skipIf(!backendAvailable('native'))('the C and TypeScript keyword scorers on the same index', () => {
  const fallbacks: NativeOperation[] = []
  const documents = corpus()
  let narsil: Narsil

  beforeAll(async () => {
    observeFallbacks(operation => fallbacks.push(operation))
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex(INDEX, {
      schema: { title: 'string', body: 'string', tags: 'string[]', rank: 'number' },
      language: 'english',
    })
    await narsil.insertBatch(INDEX, documents)
  })

  afterAll(async () => {
    observeFallbacks(null)
    await narsil.shutdown()
    expect(fallbacks).toEqual([])
  })

  it(
    'agrees bit for bit under per-query k1 and b, a field boost, and a query with many terms',
    async () => {
      await expectBothBackends(narsil, { term: 'alpha filler', limit: 10 }, PRUNED)
      await expectBothBackends(narsil, { term: 'alpha filler', limit: 10, bm25: { k1: 2.4, b: 0.1 } }, PRUNED)
      await expectBothBackends(
        narsil,
        { term: 'beta gamma filler', limit: 7, offset: 3, bm25: { fields: { title: { k1: 0, b: 1 } } } },
        PRUNED,
      )
      await expectBothBackends(narsil, { term: 'alpha filler', limit: 10, boost: { title: 3, body: 0.5 } }, PRUNED)
      const manyTerms = ['filler', ...Array.from({ length: 60 }, (_, at) => rareWord(at * 4))].join(' ')
      await expectBothBackends(narsil, { term: manyTerms, limit: 10 }, PRUNED)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'agrees bit for bit outside pruning, with one term or a minimum score',
    async () => {
      await expectBothBackends(narsil, { term: 'alpha', limit: 10 }, SCORED_IN_FULL)
      const full = await narsil.query(INDEX, { term: 'alpha filler', limit: 400 })
      await expectBothBackends(
        narsil,
        { term: 'alpha filler', limit: 10, minScore: full.hits[200].score },
        SCORED_IN_FULL,
      )
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'agrees bit for bit after a live BM25 change, length-changing writes, and one very long field',
    async () => {
      await narsil.updateBM25(INDEX, { k1: 1.9, b: 0.4, fields: { title: { k1: 0.6 } } })
      await expectBothBackends(narsil, { term: 'alpha filler', limit: 10 }, PRUNED)
      for (let index = 0; index < 400; index += 3) {
        await narsil.update(INDEX, `doc-${String(index).padStart(5, '0')}`, {
          title: 'omega',
          body: `${'alpha '.repeat((index % 5) + 1)}${'filler '.repeat((index % 41) * 9 + 1)}`,
          rank: index,
        })
      }
      for (let index = 400; index < 700; index += 2) await narsil.remove(INDEX, `doc-${String(index).padStart(5, '0')}`)
      await narsil.insert(
        INDEX,
        { title: 'delta', body: `alpha ${'filler '.repeat(LONG_FIELD_WORDS)}omega`, rank: CORPUS_SIZE },
        'doc-long',
      )
      await narsil.waitForWrites(INDEX)
      await expectBothBackends(narsil, { term: 'alpha filler', limit: 10 }, PRUNED)
      await expectBothBackends(narsil, { term: 'omega delta filler', limit: 25, offset: 10 }, PRUNED)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'agrees bit for bit after an analysis change rebuilds the terms',
    async () => {
      await narsil.changeAnalysis(INDEX, { stopWords: ['beta'] })
      await expectBothBackends(narsil, { term: 'alpha filler', limit: 10 }, PRUNED)
      await expectBothBackends(narsil, { term: 'beta gamma filler', limit: 10 }, PRUNED)
    },
    TEST_TIMEOUT_MS,
  )
})

describe.skipIf(!backendAvailable('native'))('the C and TypeScript keyword scorers across partitions', () => {
  let narsil: Narsil

  beforeAll(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex(PARTITIONED_INDEX, {
      schema: { title: 'string', body: 'string' },
      language: 'english',
      partitions: { maxPartitions: PARTITION_COUNT },
      defaultScoring: 'dfs',
    })
    const tied = idsOnPartition(TIED_PARTITION, 'tied', TIED_DOCUMENTS)
    const strays = idsOnPartition(TIED_PARTITION, 'stray', 1)
    const common = idsOnPartition(COMMON_PARTITION, 'common', COMMON_DOCUMENTS)
    const inserted = await narsil.insertBatch(PARTITIONED_INDEX, [
      ...tied.map(id => ({ id, title: 'note', body: 'alpha' })),
      ...[...strays, ...common].map(id => ({ id, title: 'note', body: 'omega' })),
    ])
    expect(inserted.failed).toEqual([])
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  it(
    'scores in full after pruning when checking every tied candidate would cost more than every row',
    async () => {
      await expectBothBackends(
        narsil,
        { term: 'alpha omega', limit: 10 },
        [PRUNED_THEN_FULL, SCORED_IN_FULL],
        PARTITIONED_INDEX,
      )
    },
    TEST_TIMEOUT_MS,
  )
})
