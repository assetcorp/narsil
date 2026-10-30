import { request } from 'node:http'
import { expect } from 'vitest'
import type { ErrorEnvelope } from '../../../server/types/options'
import type { AnyDocument } from '../../../types/schema'
import { postJson } from '../../server/helpers'
import { COMMON_TERM, INDEX } from './corpus'
import type { PatternServer } from './harness'

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

interface FreshAnswer {
  status: number
  code: string | null
  hits: number | null
  endedAt: number
}

function searchOnFreshConnection(server: PatternServer, body: unknown): Promise<FreshAnswer> {
  const payload = JSON.stringify(body)
  const url = new URL(`${server.base}/indexes/${INDEX}/search`)
  return new Promise((resolve, reject) => {
    const sent = request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      response => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => {
          const endedAt = performance.now()
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<ErrorEnvelope> & {
            hits?: unknown[]
          }
          resolve({
            status: response.statusCode ?? 0,
            code: parsed.error?.code ?? null,
            hits: Array.isArray(parsed.hits) ? parsed.hits.length : null,
            endedAt,
          })
        })
      },
    )
    sent.on('error', reject)
    sent.end(payload)
  })
}

async function expectOtherThreadsAnswerFirst(
  server: PatternServer,
  hostileBody: unknown,
  normalFilters: unknown,
  label: string,
  ordered: boolean,
): Promise<TimedResponse> {
  const started = performance.now()
  const hostile = searchOnFreshConnection(server, hostileBody)
  const normals = await Promise.all(
    Array.from({ length: server.requestThreads }, () => searchOnFreshConnection(server, searchBody(normalFilters))),
  )
  const answered = await hostile
  for (const normal of normals) {
    expect({ status: normal.status, answered: (normal.hits ?? 0) > 0 }, label).toEqual({ status: 200, answered: true })
  }
  const answeredFirst = normals.filter(normal => normal.endedAt < answered.endedAt).length
  if (ordered) expect(answeredFirst, label).toBe(server.requestThreads)
  return { status: answered.status, code: answered.code, hits: answered.hits, elapsedMs: answered.endedAt - started }
}

export async function expectServedWhileHostile(
  server: PatternServer,
  hostileBody: unknown,
  normalFilters: unknown,
  label: string,
  answersAsFastAsANormalSearch = false,
): Promise<TimedResponse> {
  if (server.requestThreads > 0) {
    return expectOtherThreadsAnswerFirst(server, hostileBody, normalFilters, label, !answersAsFastAsANormalSearch)
  }
  const hostile = timedSearch(server, hostileBody)
  const normal = await timedSearch(server, searchBody(normalFilters))
  const answered = await hostile
  expect(normal.status, label).toBe(200)
  expect(normal.hits, label).toBeGreaterThan(0)
  const normalDeadline = server.workerCopies
    ? NORMAL_SEARCH_DEADLINE_MS
    : answered.elapsedMs + NORMAL_SEARCH_DEADLINE_MS
  expect(normal.elapsedMs, label).toBeLessThan(normalDeadline)
  return answered
}

export function repeatedCodePoints(first: number, length: number): string {
  return String.fromCodePoint(...Array.from({ length }, (_, at) => first + at))
}

export function longValueCorpus(count: number, valueLength: number): AnyDocument[] {
  return Array.from({ length: count }, (_, at) => {
    const line = `${'a'.repeat(valueLength - 1)}${at % 2 === 0 ? 'b' : 'c'}`
    return { id: `long${String(at).padStart(5, '0')}`, body: COMMON_TERM, line, sku: `SKU-${at}` }
  })
}
