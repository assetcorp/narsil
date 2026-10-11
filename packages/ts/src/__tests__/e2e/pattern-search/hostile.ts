import { expect } from 'vitest'
import type { ErrorEnvelope } from '../../../server/types/options'
import type { AnyDocument } from '../../../types/schema'
import { postJson } from '../../server/helpers'
import { COMMON_TERM, INDEX } from './corpus'
import type { PatternServer } from './harness'

export const HOSTILE_SEARCH_DEADLINE_MS = 3_000
export const NORMAL_SEARCH_DEADLINE_MS = 1_000

export interface TimedResponse {
  status: number
  code: string | null
  hits: number | null
  elapsedMs: number
}

export async function timedSearch(server: PatternServer, body: unknown): Promise<TimedResponse> {
  const started = performance.now()
  const response = await postJson<ErrorEnvelope & { hits?: unknown[] }>(server.base, `/indexes/${INDEX}/search`, body)
  return {
    status: response.status,
    code: response.body?.error?.code ?? null,
    hits: Array.isArray(response.body?.hits) ? response.body.hits.length : null,
    elapsedMs: performance.now() - started,
  }
}

export function searchBody(filters: unknown): unknown {
  return { term: COMMON_TERM, filters, limit: 10 }
}

export async function expectRejected(server: PatternServer, filters: unknown, code: string): Promise<void> {
  const response = await timedSearch(server, searchBody(filters))
  expect({ status: response.status, code: response.code }, JSON.stringify(filters).slice(0, 200)).toEqual({
    status: 400,
    code,
  })
}

export async function expectServedWhileHostile(
  server: PatternServer,
  hostileBody: unknown,
  normalFilters: unknown,
): Promise<TimedResponse> {
  const hostile = timedSearch(server, hostileBody)
  const normal = await timedSearch(server, searchBody(normalFilters))
  const answered = await hostile
  expect(normal.status).toBe(200)
  expect(normal.hits).toBeGreaterThan(0)
  expect(answered.elapsedMs).toBeLessThan(HOSTILE_SEARCH_DEADLINE_MS)
  const normalDeadline = server.workerCopies
    ? NORMAL_SEARCH_DEADLINE_MS
    : answered.elapsedMs + NORMAL_SEARCH_DEADLINE_MS
  expect(normal.elapsedMs).toBeLessThan(normalDeadline)
  return answered
}

export function repeatedCodePoints(first: number, length: number): string {
  return String.fromCodePoint(...Array.from({ length }, (_, at) => first + at))
}

export function longValueCorpus(count: number, valueLength: number): AnyDocument[] {
  return Array.from({ length: count }, (_, at) => {
    const line = `${'a'.repeat(valueLength - 1)}${at % 2 === 0 ? 'b' : 'c'}`
    return { id: `long${String(at).padStart(5, '0')}`, body: COMMON_TERM, line, lineText: line, sku: `SKU-${at}` }
  })
}
