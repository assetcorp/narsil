import { existsSync } from 'node:fs'
import { expect } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../../client'
import type { Narsil } from '../../../narsil'
import type { NarsilConfig } from '../../../types/config'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import { scaledOut, startTestServer, waitFor } from '../../server/helpers'
import { INDEX, LANGUAGE_NAME, PROBE_TERMS, SCHEMA, workshopBootstrapModule } from './corpus'
import type { Oracle, OracleHit, OracleQuery } from './oracle'

export const WORKERS_BUILT = existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))
export const NO_WORKERS: NarsilConfig['workers'] = { enabled: false }
export const RESULT_LIMIT = 10_000
const RELATIVE_SCORE_TOLERANCE = 1e-9

export function workerCopies(): NarsilConfig['workers'] {
  return { promotionThreshold: 200, count: 2, mainCopyQueries: 'none', bootstrapModule: workshopBootstrapModule() }
}

export const WORKSHOP_INDEX_CONFIG = { schema: SCHEMA, language: LANGUAGE_NAME, partitions: { maxPartitions: 1 } }

export interface WorkshopServer {
  readonly engine: Narsil
  readonly client: NarsilClient
  readonly base: string
  stop(): Promise<void>
}

export async function startWorkshopServer(config: NarsilConfig): Promise<WorkshopServer> {
  const started = await startTestServer(undefined, config)
  return {
    engine: started.engine,
    client: createNarsilClient({ url: started.base }),
    base: started.base,
    stop: () => started.stop(),
  }
}

export async function insertAll(server: WorkshopServer, documents: AnyDocument[]): Promise<void> {
  const inserted = await server.client.insertBatch(INDEX, documents)
  expect(inserted.failed).toEqual([])
}

export async function createWorkshopIndex(server: WorkshopServer, documents: AnyDocument[]): Promise<void> {
  await server.client.createIndex(INDEX, WORKSHOP_INDEX_CONFIG)
  await insertAll(server, documents)
}

export async function waitForWorkerCopies(server: WorkshopServer): Promise<void> {
  await waitFor(() => scaledOut(server.engine, INDEX))
}

export const QUERY_SHAPES: readonly Omit<OracleQuery, 'term'>[] = [
  { partialWords: true },
  { partialWords: true, prefix: true },
  { partialWords: true, tolerance: 1 },
  { partialWords: true, prefix: true, tolerance: 1 },
  { partialWords: true, fields: ['title'] },
  { partialWords: true, fields: ['body'] },
  { partialWords: true, termMatch: 'all' },
  { partialWords: true, boost: { title: 2.5, body: 0.5 } },
  { partialWords: true, exact: true },
  { partialWords: false },
  { prefix: true },
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

export type HitComparison = 'ids and scores' | 'ids'

export function expectSameHits(
  found: readonly OracleHit[],
  expected: readonly OracleHit[],
  label: string,
  comparison: HitComparison = 'ids and scores',
): void {
  expect(found.map(hit => hit.id).sort(), label).toEqual(expected.map(hit => hit.id).sort())
  if (comparison === 'ids') return
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

export async function expectEveryProbe(
  search: SearchFn,
  oracle: Oracle,
  label: string,
  comparison: HitComparison = 'ids and scores',
): Promise<number> {
  let matched = 0
  for (const query of probeQueries()) {
    const expected = oracle.search(query)
    expectSameHits(await search(query), expected, `${label} ${JSON.stringify(query)}`, comparison)
    matched += expected.length
  }
  return matched
}
