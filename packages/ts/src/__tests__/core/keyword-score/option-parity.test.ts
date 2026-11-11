import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { observeKeywordScoringPaths } from '../../../core/keyword-score/native'
import { createNarsil, type Narsil } from '../../../narsil'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import { type NativeOperation, observeFallbacks, setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import { seededRandom } from '../../integration/filtered-vectors/library'
import { backendAvailable, searchThrough } from '../../integration/filtered-vectors/search-backend'

const INDEX = 'option-parity'
const CORPUS_SIZE = 1500
const TEST_TIMEOUT_MS = 120_000
const VOCABULARY = [
  'car',
  'auto',
  'vehicle',
  'motor',
  'motors',
  'motorway',
  'engine',
  'waterproof',
  'proofing',
  'roof',
  'garage',
  'repair',
  'wheel',
  'wheels',
  'brake',
  'filler',
]
const SYNONYM_WORDS = ['car', 'auto', 'vehicle']
const PAGE_SIZES = [10, 100]

searchThrough('native')

function phraseOf(random: () => number, words: number): string {
  const picked: string[] = []
  for (let at = 0; at < words; at++) picked.push(VOCABULARY[Math.floor(random() * VOCABULARY.length)])
  return picked.join(' ')
}

function corpus(): AnyDocument[] {
  const random = seededRandom(20261106)
  const documents: AnyDocument[] = []
  for (let index = 0; index < CORPUS_SIZE; index++) {
    documents.push({
      id: `doc-${String(index).padStart(5, '0')}`,
      title: phraseOf(random, 1 + Math.floor(random() * 6)),
      body: phraseOf(random, 3 + Math.floor(random() * 90)),
      abstract: phraseOf(random, 2 + Math.floor(random() * 30)),
      notes: phraseOf(random, 1 + Math.floor(random() * 12)),
    })
  }
  return documents
}

interface Scored {
  ids: string[]
  scores: number[]
  count: number
  paths: number[]
}

async function scoredBy(narsil: Narsil, params: QueryParams, native: boolean): Promise<Scored> {
  setNativeSearchCoreEnabled(native)
  const paths: number[] = []
  observeKeywordScoringPaths(path => paths.push(path))
  try {
    const result = await narsil.query(INDEX, params)
    return {
      ids: result.hits.map(hit => hit.id),
      scores: result.hits.map(hit => hit.score ?? Number.NaN),
      count: result.count,
      paths,
    }
  } finally {
    observeKeywordScoringPaths(null)
    setNativeSearchCoreEnabled(true)
  }
}

async function expectBothBackends(narsil: Narsil, params: QueryParams): Promise<void> {
  const label = JSON.stringify(params)
  const typeScript = await scoredBy(narsil, params, false)
  const core = await scoredBy(narsil, params, true)
  expect(typeScript.paths, label).toEqual([])
  expect(core.paths.length, label).toBeGreaterThan(0)
  expect(core.count, label).toBeGreaterThan(0)
  expect(core.count, label).toBe(typeScript.count)
  expect(core.ids, label).toEqual(typeScript.ids)
  for (let at = 0; at < core.scores.length; at++) {
    expect(Object.is(core.scores[at], typeScript.scores[at]), `${label} rank ${at}`).toBe(true)
  }
}

describe.skipIf(!backendAvailable('native'))('the C and TypeScript keyword scorers under every query option', () => {
  const fallbacks: NativeOperation[] = []
  let narsil: Narsil

  beforeAll(async () => {
    observeFallbacks(operation => fallbacks.push(operation))
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex(INDEX, {
      schema: { title: 'string', body: 'string:partial', abstract: 'string', notes: 'string' },
      language: 'english',
      trackPositions: true,
      synonyms: [{ words: SYNONYM_WORDS }],
    })
    const inserted = await narsil.insertBatch(INDEX, corpus())
    expect(inserted.failed).toEqual([])
  })

  afterAll(async () => {
    observeFallbacks(null)
    await narsil.shutdown()
    expect(fallbacks).toEqual([])
  })

  it(
    'agrees bit for bit when a synonym group adds rows from several fields of one document',
    async () => {
      for (const limit of PAGE_SIZES) {
        for (const term of ['car', 'auto repair', 'garage vehicle wheel']) {
          await expectBothBackends(narsil, { term, limit })
        }
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'agrees bit for bit under typo tolerance, prefix completion, and partial words',
    async () => {
      for (const limit of PAGE_SIZES) {
        await expectBothBackends(narsil, { term: 'motr garge', tolerance: 1, limit })
        await expectBothBackends(narsil, { term: 'wheals brakk', tolerance: 2, limit })
        await expectBothBackends(narsil, { term: 'repair moto', prefix: true, limit })
        await expectBothBackends(narsil, { term: 'proof', partialWords: true, limit })
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'agrees bit for bit with phrases and with every term required',
    async () => {
      for (const limit of PAGE_SIZES) {
        await expectBothBackends(narsil, { term: '"motor engine" garage', limit })
        await expectBothBackends(narsil, { term: 'car motor wheel', termMatch: 'all', limit })
        await expectBothBackends(narsil, { term: 'garge motr', tolerance: 1, termMatch: 'all', limit })
      }
    },
    TEST_TIMEOUT_MS,
  )
})
