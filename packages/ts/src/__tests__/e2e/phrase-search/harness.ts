import { existsSync } from 'node:fs'
import { expect } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../../client'
import type { Narsil } from '../../../narsil'
import type { NarsilConfig } from '../../../types/config'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import { startTestServer } from '../../server/helpers'
import { INDEX, LANGUAGE_NAME, PROBE_TERMS, pantryBootstrapModule, QUERY_SHAPES, SCHEMA } from './corpus'
import { createOracle, type OracleHit, type OracleQuery } from './oracle'

export const WORKERS_BUILT = existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))
export const NO_WORKERS: NarsilConfig['workers'] = { enabled: false }
export const RESULT_LIMIT = 10_000
const RELATIVE_SCORE_TOLERANCE = 1e-9

export const PANTRY_CONFIG = { schema: SCHEMA, language: LANGUAGE_NAME, partitions: { maxPartitions: 1 } }

export function workerCopies(): NarsilConfig['workers'] {
  return { promotionThreshold: 200, count: 2, mainCopyQueries: 'none', bootstrapModule: pantryBootstrapModule() }
}

export interface PantryServer {
  readonly engine: Narsil
  readonly client: NarsilClient
  readonly base: string
  stop(): Promise<void>
}

export async function startPantryServer(config: NarsilConfig): Promise<PantryServer> {
  const started = await startTestServer(undefined, config)
  return {
    engine: started.engine,
    client: createNarsilClient({ url: started.base }),
    base: started.base,
    stop: () => started.stop(),
  }
}

export type SearchFn = (query: OracleQuery) => Promise<OracleHit[]>

export function hitsOf(result: { hits: Array<{ id: string; score?: number }> }): OracleHit[] {
  return result.hits.map(hit => ({ id: hit.id, score: hit.score ?? Number.NaN }))
}

export function queryParamsOf(query: OracleQuery): QueryParams {
  const { shelf, ...rest } = query
  return {
    ...rest,
    limit: RESULT_LIMIT,
    ...(shelf === undefined ? {} : { filters: { fields: { shelf: { eq: shelf } } } }),
  } as QueryParams
}

export function searchOver(reader: Pick<NarsilClient, 'query'>): SearchFn {
  return async query => hitsOf(await reader.query(INDEX, queryParamsOf(query)))
}

export function expectSameHits(found: readonly OracleHit[], expected: readonly OracleHit[], label: string): void {
  expect(found.map(hit => hit.id).sort(), label).toEqual(expected.map(hit => hit.id).sort())
  const expectedScores = new Map(expected.map(hit => [hit.id, hit.score]))
  for (const hit of found) {
    const score = expectedScores.get(hit.id) ?? Number.NaN
    expect(
      Math.abs(hit.score - score),
      `${label} ${hit.id} scored ${hit.score}, expected ${score}`,
    ).toBeLessThanOrEqual(RELATIVE_SCORE_TOLERANCE * Math.max(1, Math.abs(score)))
  }
}

export async function expectEveryProbe(
  search: SearchFn,
  documents: readonly AnyDocument[],
  label: string,
): Promise<number> {
  const oracle = createOracle(documents)
  let matched = 0
  for (const term of PROBE_TERMS) {
    for (const shape of QUERY_SHAPES) {
      const query = { term, ...shape } as OracleQuery
      const expected = oracle.search(query)
      expectSameHits(await search(query), expected, `${label} ${JSON.stringify(query)}`)
      matched += expected.length
    }
  }
  return matched
}
