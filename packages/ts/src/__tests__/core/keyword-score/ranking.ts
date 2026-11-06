import { existsSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, expect } from 'vitest'
import type { Narsil } from '../../../narsil'
import type { QueryParams } from '../../../types/search'
import { type NativeOperation, observeFallbacks, setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import { loadNativeCore } from '../../../vector/native/loader'
import { hostCore } from '../../integration/filtered-vectors/search-backend'

export const EVERY_MATCH = 10_000

export interface KeywordBackend {
  readonly name: string
  readonly native: boolean
}

export const KEYWORD_BACKENDS: readonly KeywordBackend[] = [
  { name: 'the TypeScript scorer', native: false },
  ...(existsSync(hostCore) ? [{ name: 'the C scorer', native: true }] : []),
]

export function scoreThrough(backend: KeywordBackend): void {
  const fallbacks: NativeOperation[] = []
  const previousPath = process.env.NARSIL_NATIVE_CORE_PATH

  beforeAll(() => {
    if (backend.native) {
      process.env.NARSIL_NATIVE_CORE_PATH = hostCore
      expect(loadNativeCore()).not.toBeNull()
    }
    setNativeSearchCoreEnabled(backend.native)
    observeFallbacks(operation => fallbacks.push(operation))
  })

  afterEach(() => {
    expect(fallbacks).toEqual([])
  })

  afterAll(() => {
    observeFallbacks(null)
    setNativeSearchCoreEnabled(true)
    if (previousPath === undefined) delete process.env.NARSIL_NATIVE_CORE_PATH
    else process.env.NARSIL_NATIVE_CORE_PATH = previousPath
  })
}

export interface Reference {
  readonly keepsZeroScores: boolean
}

export const UNPRUNABLE: Reference = { keepsZeroScores: false }
export const UNLIMITED: Reference = { keepsZeroScores: true }

function referenceParams(params: QueryParams, reference: Reference): QueryParams {
  const unpaged: QueryParams = { ...params, limit: EVERY_MATCH, offset: 0 }
  if (reference.keepsZeroScores || (params.minScore ?? 0) > 0) return unpaged
  return { ...unpaged, minScore: Number.MIN_VALUE }
}

export async function expectPageOfFullRanking(
  narsil: Narsil,
  indexName: string,
  params: QueryParams,
  reference: Reference = UNPRUNABLE,
): Promise<void> {
  const page = await narsil.query(indexName, params)
  const full = await narsil.query(indexName, referenceParams(params, reference))
  expect(page.count).toBe(full.count)
  const offset = params.offset ?? 0
  const limit = params.limit ?? 10
  const expected = full.hits.slice(offset, offset + limit)
  expect(page.hits.map(hit => hit.id)).toEqual(expected.map(hit => hit.id))
  for (let at = 0; at < page.hits.length; at++) {
    expect(Object.is(page.hits[at].score, expected[at].score)).toBe(true)
  }
  if (params.facets !== undefined) expect(page.facets).toEqual(full.facets)
}

export async function expectSortedMatchesOfFullRanking(
  narsil: Narsil,
  indexName: string,
  params: QueryParams,
): Promise<void> {
  const sorted = await narsil.query(indexName, { ...params, limit: EVERY_MATCH, sort: { rank: 'asc' } })
  const full = await narsil.query(indexName, referenceParams(params, UNPRUNABLE))
  expect(sorted.count).toBe(full.count)
  expect(sorted.hits.map(hit => hit.id).sort()).toEqual(full.hits.map(hit => hit.id).sort())
}
