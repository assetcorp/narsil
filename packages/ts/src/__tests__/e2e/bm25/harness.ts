import { expect } from 'vitest'
import type { AnyDocument, BM25Params } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import { seededRandom } from '../../filters/pattern/random-corpus'
import { INDEX } from '../synonyms/corpus'
import type { Bm25Oracle, OracleHit, OracleQuery } from './oracle'

const RELATIVE_SCORE_TOLERANCE = 1e-9
const COMMON_WORDS = ['road', 'river', 'stone', 'city']
const RARE_WORDS = ['film', 'truck', 'green', 'night', 'house', 'light', 'rock', 'cat']
export const FULL_LIMIT = 10_000

export const TITLE_HEAVY: BM25Params = { k1: 0.5, b: 0.2, fields: { title: { k1: 3, b: 1 } } }
export const SETTINGS: ReadonlyArray<{ label: string; index?: BM25Params; search?: BM25Params }> = [
  { label: 'defaults' },
  { label: 'index pair', index: { k1: 2, b: 0.3 } },
  { label: 'field pairs', index: TITLE_HEAVY },
  { label: 'one value on a field', index: { fields: { body: { b: 0 } } } },
  { label: 'search pair', search: { k1: 0.9, b: 0.1 } },
  { label: 'search pair over field pairs', index: TITLE_HEAVY, search: { k1: 1.7 } },
  { label: 'search field over everything', index: TITLE_HEAVY, search: { b: 0.4, fields: { title: { k1: 6 } } } },
  { label: 'k1 0 and k1 1,000', index: { fields: { title: { k1: 0 }, body: { k1: 1_000 } } } },
  { label: 'k1 1,000 and k1 0', index: { fields: { title: { k1: 1_000 }, body: { k1: 0 } } } },
  { label: 'b 0 and b 1', index: { fields: { title: { b: 0 }, body: { b: 1 } } } },
  { label: 'b 1 and b 0', index: { fields: { title: { b: 1 }, body: { b: 0 } } } },
  { label: 'k1 1,000 with b 1', index: { k1: 1_000, b: 1 } },
  { label: 'k1 0 with b 0', index: { k1: 0, b: 0 } },
]

const TERMS = ['road', 'film', 'road river', 'stone film truck', 'the city of the night']
const SHAPES: ReadonlyArray<Omit<OracleQuery, 'term'>> = [
  { limit: 1 },
  { limit: 5 },
  { limit: 25 },
  { limit: 25, fields: ['title'] },
  { limit: 25, fields: ['body'] },
  { limit: FULL_LIMIT },
]

export function bm25Corpus(count: number, seed: number, idPrefix = 'doc'): AnyDocument[] {
  const random = seededRandom(seed)
  const word = (): string =>
    random() < 0.7
      ? COMMON_WORDS[Math.floor(random() * COMMON_WORDS.length)]
      : RARE_WORDS[Math.floor(random() * RARE_WORDS.length)]
  const words = (least: number, most: number): string =>
    Array.from({ length: least + Math.floor(random() * random() * (most - least + 1)) }, word).join(' ')
  return Array.from({ length: count }, (_, at) => ({
    id: `${idPrefix}${String(at).padStart(5, '0')}`,
    title: words(1, 6),
    body: words(2, 60),
  }))
}

export type Bm25Search = (query: OracleQuery, search: BM25Params | undefined) => Promise<OracleHit[]>

export function searchWith(
  reader: { query(indexName: string, params: QueryParams): Promise<{ hits: Array<{ id: string; score?: number }> }> },
  extra: Partial<QueryParams> = {},
): Bm25Search {
  return async (query, search) => {
    const result = await reader.query(INDEX, {
      term: query.term,
      limit: query.limit ?? FULL_LIMIT,
      ...(query.fields !== undefined ? { fields: query.fields } : {}),
      ...(search !== undefined ? { bm25: search } : {}),
      ...extra,
    })
    return result.hits.map(hit => ({ id: hit.id, score: hit.score ?? Number.NaN }))
  }
}

export function differsFromOracle(
  found: readonly OracleHit[],
  oracle: Bm25Oracle,
  query: OracleQuery,
  index: BM25Params | undefined,
  searchSetting?: BM25Params,
): string | null {
  const all = oracle.search({ term: query.term, fields: query.fields }, index, searchSetting)
  const expected = query.limit === undefined ? all : all.slice(0, query.limit)
  if (found.length !== expected.length) return `${found.length} hits, expected ${expected.length}`
  const scoreById = new Map(all.map(hit => [hit.id, hit.score]))
  const seen = new Set<string>()
  for (let at = 0; at < found.length; at++) {
    const hit = found[at]
    const want = expected[at].score
    if (!scoresMatch(hit.score, want)) return `rank ${at} scored ${hit.score}, expected ${want}`
    const own = scoreById.get(hit.id)
    if (own === undefined) return `${hit.id} at rank ${at} matches no document that the oracle scored`
    if (!scoresMatch(hit.score, own)) return `${hit.id} scored ${hit.score}, the oracle gives it ${own}`
    if (seen.has(hit.id)) return `${hit.id} appeared twice`
    seen.add(hit.id)
  }
  return null
}

function scoresMatch(left: number, right: number): boolean {
  return Math.abs(left - right) <= RELATIVE_SCORE_TOLERANCE * Math.max(1, Math.abs(right))
}

export async function expectOracleScores(
  search: Bm25Search,
  oracle: Bm25Oracle,
  index: BM25Params | undefined,
  searchSetting: BM25Params | undefined,
  label: string,
): Promise<void> {
  for (const term of TERMS) {
    for (const shape of SHAPES) {
      const query = { term, ...shape }
      const found = await search(query, searchSetting)
      expect(
        differsFromOracle(found, oracle, query, index, searchSetting),
        `${label} ${JSON.stringify(query)}`,
      ).toBeNull()
    }
  }
}
