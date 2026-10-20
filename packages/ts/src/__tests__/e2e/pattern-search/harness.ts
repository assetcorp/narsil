import { existsSync } from 'node:fs'
import { expect } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../../client'
import type { Narsil } from '../../../narsil'
import type { ServerOptions } from '../../../server'
import type { NarsilConfig } from '../../../types/config'
import type { FieldFilter } from '../../../types/filters'
import type { AnyDocument } from '../../../types/schema'
import { scaledOut, startTestServer, waitFor } from '../../server/helpers'
import { COMMON_TERM, INDEX, SCHEMA } from './corpus'

export const WORKERS_BUILT = existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))
export const WORKER_COPIES: NarsilConfig['workers'] = { promotionThreshold: 200, count: 4, mainCopyQueries: 'none' }
export const NO_WORKERS: NarsilConfig['workers'] = { enabled: false }
const RESULT_LIMIT = 10_000

export interface PatternServer {
  readonly engine: Narsil
  readonly client: NarsilClient
  readonly base: string
  readonly workerCopies: boolean
  readonly requestThreads: number
  stop(): Promise<void>
}

export async function startPatternServer(
  config: NarsilConfig,
  options?: Omit<ServerOptions, 'host' | 'port'>,
): Promise<PatternServer> {
  const started = await startTestServer(options, config)
  return {
    engine: started.engine,
    client: createNarsilClient({ url: started.base }),
    base: started.base,
    workerCopies: config.workers?.enabled !== false,
    requestThreads: started.server.requestThreadCount,
    stop: () => started.stop(),
  }
}

export async function loadCorpus(server: PatternServer, documents: AnyDocument[], maxPartitions = 4): Promise<void> {
  await server.client.createIndex(INDEX, { schema: SCHEMA, partitions: { maxPartitions } })
  const inserted = await server.client.insertBatch(INDEX, documents)
  expect(inserted.failed).toEqual([])
  if (server.workerCopies) await waitFor(() => scaledOut(server.engine, INDEX))
}

export async function searchIds(server: PatternServer, field: string, filter: FieldFilter): Promise<string[]> {
  const result = await server.client.query(INDEX, {
    term: COMMON_TERM,
    filters: { fields: { [field]: filter } },
    limit: RESULT_LIMIT,
  })
  return result.hits.map(hit => hit.id).sort()
}

export async function listIds(server: PatternServer, field: string, filter: FieldFilter): Promise<string[]> {
  const response = await fetch(`${server.base}/indexes/${INDEX}/documents/_list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filters: { fields: { [field]: filter } }, limit: RESULT_LIMIT }),
  })
  expect(response.status).toBe(200)
  const page = (await response.json()) as { documents: Array<{ id: string }> }
  return page.documents.map(document => document.id).sort()
}

export async function countOf(server: PatternServer, field: string, filter: FieldFilter): Promise<number> {
  const preflight = await server.client.preflight(INDEX, {
    term: COMMON_TERM,
    filters: { fields: { [field]: filter } },
  })
  return preflight.count
}
