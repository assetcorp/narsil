import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clearNormalizationCache, tokenize } from '../../../core/tokenizer'
import { english } from '../../../languages/english'
import { createNarsil, type Narsil } from '../../../narsil'
import { type NativeOperation, observeFallbacks, setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import { differsFromOracle } from '../../e2e/bm25/harness'
import type { Bm25Oracle, OracleHit } from '../../e2e/bm25/oracle'
import { backendAvailable, searchThrough } from '../../integration/filtered-vectors/search-backend'

const FIELDS = ['title', 'text']
const K1 = 1.2
const B = 0.75
const PAGE_SIZES = [10, 100]
const INDEX = 'scifact'
const TEST_TIMEOUT_MS = 240_000

interface Fixture {
  id: number
  title?: string
  text: string
}

searchThrough('native')

function fixture<T>(name: string): T[] {
  return JSON.parse(readFileSync(new URL(`../../relevance/fixtures/${name}`, import.meta.url), 'utf-8')) as T[]
}

function termsOf(text: string): string[] {
  return tokenize(text, english).tokens.map(entry => entry.token)
}

function scifactOracle(documents: readonly Fixture[]): Bm25Oracle {
  const frequency = new Map<string, number>()
  const totalLength = new Map<string, number>()
  const parsed = documents.map(document => {
    const counts = new Map<string, Map<string, number>>()
    const lengths = new Map<string, number>()
    const held = new Set<string>()
    for (const field of FIELDS) {
      const terms = termsOf(field === 'title' ? (document.title ?? '') : document.text)
      const fieldCounts = new Map<string, number>()
      for (const term of terms) {
        fieldCounts.set(term, (fieldCounts.get(term) ?? 0) + 1)
        held.add(term)
      }
      counts.set(field, fieldCounts)
      lengths.set(field, terms.length)
      totalLength.set(field, (totalLength.get(field) ?? 0) + terms.length)
    }
    for (const term of held) frequency.set(term, (frequency.get(term) ?? 0) + 1)
    return { id: String(document.id), counts, lengths }
  })
  const total = documents.length
  return {
    search(query) {
      const terms = [...new Set(termsOf(query.term))]
      const hits: OracleHit[] = []
      for (const document of parsed) {
        let score = 0
        let matched = false
        for (const term of terms) {
          const held = frequency.get(term) ?? 0
          const idf = Math.log((total - held + 0.5) / (held + 0.5) + 1)
          for (const field of FIELDS) {
            const count = document.counts.get(field)?.get(term) ?? 0
            if (count === 0) continue
            matched = true
            const average = (totalLength.get(field) ?? 0) / total
            const length = document.lengths.get(field) ?? 0
            score += (idf * count * (K1 + 1)) / (count + K1 * (1 - B + (B * length) / average))
          }
        }
        if (matched) hits.push({ id: document.id, score })
      }
      hits.sort((left, right) => right.score - left.score)
      return query.limit === undefined ? hits : hits.slice(0, query.limit)
    },
  }
}

async function hitsThrough(narsil: Narsil, term: string, limit: number, native: boolean) {
  setNativeSearchCoreEnabled(native)
  try {
    const result = await narsil.query(INDEX, { term, limit, tolerance: 0 })
    return { count: result.count, hits: result.hits.map(hit => ({ id: hit.id, score: hit.score ?? Number.NaN })) }
  } finally {
    setNativeSearchCoreEnabled(true)
  }
}

describe.skipIf(!backendAvailable('native'))('every SciFact query through the C and TypeScript scorers', () => {
  const fallbacks: NativeOperation[] = []
  const documents = fixture<Fixture>('scifact-documents.json')
  const queries = fixture<{ id: number; text: string }>('scifact-queries.json')
  let narsil: Narsil
  let oracle: Bm25Oracle

  beforeAll(async () => {
    observeFallbacks(operation => fallbacks.push(operation))
    setNativeSearchCoreEnabled(false)
    clearNormalizationCache()
    oracle = scifactOracle(documents)
    setNativeSearchCoreEnabled(true)
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex(INDEX, { schema: { title: 'string', text: 'string' }, language: 'english' })
    const inserted = await narsil.insertBatch(
      INDEX,
      documents.map(document => ({ id: String(document.id), title: document.title ?? '', text: document.text })),
    )
    expect(inserted.failed).toEqual([])
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    observeFallbacks(null)
    await narsil.shutdown()
  })

  it(
    'returns the same documents, order, count, and bit-identical scores, matching BM25 computed by the test',
    async () => {
      const wrong: string[] = []
      for (const query of queries) {
        for (const limit of PAGE_SIZES) {
          const typeScript = await hitsThrough(narsil, query.text, limit, false)
          const core = await hitsThrough(narsil, query.text, limit, true)
          const label = `query ${query.id} limit ${limit}`
          expect(core.count, label).toBe(typeScript.count)
          expect(
            core.hits.map(hit => hit.id),
            label,
          ).toEqual(typeScript.hits.map(hit => hit.id))
          for (let at = 0; at < core.hits.length; at++) {
            expect(Object.is(core.hits[at].score, typeScript.hits[at].score), `${label} rank ${at}`).toBe(true)
          }
          const differs = differsFromOracle(core.hits, oracle, { term: query.text, limit }, undefined)
          if (differs !== null) wrong.push(`${label}: ${differs}`)
        }
      }
      expect(wrong).toEqual([])
      expect(fallbacks).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )
})
