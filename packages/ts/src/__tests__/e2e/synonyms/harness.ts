import { existsSync } from 'node:fs'
import { expect } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../../client'
import type { Narsil } from '../../../narsil'
import type { NarsilConfig } from '../../../types/config'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import type { SynonymRule } from '../../../types/synonyms'
import { scaledOut, startTestServer, waitFor } from '../../server/helpers'
import { garageBootstrapModule, INDEX, LANGUAGE_NAME, PROBE_TERMS, SCHEMA } from './corpus'
import type { Oracle, OracleHit, OracleQuery } from './oracle'

export const WORKERS_BUILT = existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))
export const NO_WORKERS: NarsilConfig['workers'] = { enabled: false }
export const RESULT_LIMIT = 10_000
const RELATIVE_SCORE_TOLERANCE = 1e-9

export function workerCopies(): NarsilConfig['workers'] {
  return { promotionThreshold: 200, count: 2, mainCopyQueries: 'none', bootstrapModule: garageBootstrapModule() }
}

export function garageConfig(synonyms: SynonymRule[]) {
  return { schema: SCHEMA, language: LANGUAGE_NAME, partitions: { maxPartitions: 1 }, synonyms }
}

export interface GarageServer {
  readonly engine: Narsil
  readonly client: NarsilClient
  readonly base: string
  stop(): Promise<void>
}

export async function startGarageServer(config: NarsilConfig): Promise<GarageServer> {
  const started = await startTestServer(undefined, config)
  return {
    engine: started.engine,
    client: createNarsilClient({ url: started.base }),
    base: started.base,
    stop: () => started.stop(),
  }
}

export async function insertAll(server: GarageServer, documents: AnyDocument[]): Promise<void> {
  const inserted = await server.client.insertBatch(INDEX, documents)
  expect(inserted.failed).toEqual([])
}

export async function createGarageIndex(
  server: GarageServer,
  documents: AnyDocument[],
  synonyms: SynonymRule[],
): Promise<void> {
  await server.client.createIndex(INDEX, garageConfig(synonyms))
  await insertAll(server, documents)
}

export async function waitForWorkerCopies(server: GarageServer): Promise<void> {
  await waitFor(() => scaledOut(server.engine, INDEX))
}

export const QUERY_SHAPES: readonly Omit<OracleQuery, 'term'>[] = [
  {},
  { tolerance: 1 },
  { fields: ['title'] },
  { boost: { title: 2.5, body: 0.5 } },
  { termMatch: 'all' },
  { exact: true },
]

export function probeQueries(): OracleQuery[] {
  return PROBE_TERMS.flatMap(term => QUERY_SHAPES.map(shape => ({ term, ...shape })))
}

export type SearchFn = (query: OracleQuery) => Promise<OracleHit[]>

export function hitsOf(result: { hits: Array<{ id: string; score?: number }> }): OracleHit[] {
  return result.hits.map(hit => ({ id: hit.id, score: hit.score ?? Number.NaN }))
}

export function searchOver(client: Pick<NarsilClient, 'query'>): SearchFn {
  return async query => hitsOf(await client.query(INDEX, { ...query, limit: RESULT_LIMIT } as QueryParams))
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
  for (let at = 1; at < found.length; at++) {
    expect(found[at].score, `${label} order at ${at}`).toBeLessThanOrEqual(found[at - 1].score)
  }
}

export async function expectEveryProbe(search: SearchFn, oracle: Oracle, label: string): Promise<number> {
  let matched = 0
  for (const query of probeQueries()) {
    const expected = oracle.search(query)
    expectSameHits(await search(query), expected, `${label} ${JSON.stringify(query)}`)
    matched += expected.length
  }
  return matched
}
