import { request } from 'node:http'
import { expect } from 'vitest'
import type { ErrorEnvelope } from '../../../server/types/options'
import type { AnyDocument } from '../../../types/schema'
import { postJson } from '../../server/helpers'
import { COMMON_TERM, INDEX } from './corpus'
import type { PatternServer } from './harness'
import type { LongQueryGate } from './long-query-gate'

export const NORMAL_SEARCH_DEADLINE_MS = 1_000
const SEARCH_ANSWER_TIMEOUT_MS = 60_000
const NORMALS_WHILE_HELD_MS = 5_000
const HELD_CONTEST_ATTEMPTS = 3

export interface TimedResponse {
  status: number
  code: string | null
  hits: number | null
  ids: string[] | null
  count: number | null
  elapsedMs: number
}

interface SearchAnswer extends Partial<ErrorEnvelope> {
  hits?: Array<{ id?: unknown }>
  count?: unknown
}

function answerOf(status: number, body: SearchAnswer | undefined): Omit<TimedResponse, 'elapsedMs'> {
  const hits = Array.isArray(body?.hits) ? body.hits : null
  return {
    status,
    code: body?.error?.code ?? null,
    hits: hits === null ? null : hits.length,
    ids: hits === null ? null : hits.map(hit => String(hit.id)),
    count: typeof body?.count === 'number' ? body.count : null,
  }
}

export async function timedSearch(server: PatternServer, body: unknown): Promise<TimedResponse> {
  const started = performance.now()
  const response = await postJson<SearchAnswer>(server.base, `/indexes/${INDEX}/search`, body)
  return { ...answerOf(response.status, response.body), elapsedMs: performance.now() - started }
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

interface FreshAnswer extends Omit<TimedResponse, 'elapsedMs'> {
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
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SearchAnswer
          resolve({ ...answerOf(response.statusCode ?? 0, parsed), endedAt })
        })
      },
    )
    sent.setTimeout(SEARCH_ANSWER_TIMEOUT_MS, () => {
      sent.destroy(new Error(`The server gave no answer within ${SEARCH_ANSWER_TIMEOUT_MS} ms`))
    })
    sent.on('error', reject)
    sent.end(payload)
  })
}

function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}

interface Contest {
  started: number
  hostile: Promise<FreshAnswer>
  normals: FreshAnswer[]
}

function normalSearches(server: PatternServer, normalFilters: unknown): Promise<FreshAnswer[]> {
  return Promise.all(
    Array.from({ length: server.requestThreads }, () => searchOnFreshConnection(server, searchBody(normalFilters))),
  )
}

async function contestWhileHeld(
  server: PatternServer,
  hostileBody: unknown,
  normalFilters: unknown,
  label: string,
  held: LongQueryGate,
): Promise<Contest | null> {
  await held.close()
  const started = performance.now()
  let settled = false
  const hostile = searchOnFreshConnection(server, hostileBody).finally(() => {
    settled = true
  })
  void hostile.catch(() => undefined)
  const normals = normalSearches(server, normalFilters)
  let answered: FreshAnswer[] | null = null
  let answeredWhileHeld = false
  try {
    answered = await within(normals, NORMALS_WHILE_HELD_MS)
  } finally {
    answeredWhileHeld = settled
    held.open()
  }
  expect(answeredWhileHeld, `${label} answered while the long-query thread was held`).toBe(false)
  if (answered !== null) return { started, hostile, normals: answered }
  await Promise.allSettled([hostile, normals])
  const { movedSinceClosed } = await held.report()
  if (movedSinceClosed > 1) return null
  throw new Error(
    `${label}: the normal searches gave no answer within ${NORMALS_WHILE_HELD_MS} ms, while the long-query thread took in ${movedSinceClosed} moved searches`,
  )
}

async function contest(
  server: PatternServer,
  hostileBody: unknown,
  normalFilters: unknown,
  label: string,
  held: LongQueryGate | undefined,
): Promise<Contest> {
  if (held === undefined) {
    const started = performance.now()
    const hostile = searchOnFreshConnection(server, hostileBody)
    void hostile.catch(() => undefined)
    return { started, hostile, normals: await normalSearches(server, normalFilters) }
  }
  for (let attempt = 0; attempt < HELD_CONTEST_ATTEMPTS; attempt++) {
    const decided = await contestWhileHeld(server, hostileBody, normalFilters, label, held)
    if (decided !== null) return decided
  }
  throw new Error(`${label}: a normal search waited on the held long-query thread in every attempt`)
}

async function expectOtherThreadsAnswerFirst(
  server: PatternServer,
  hostileBody: unknown,
  normalFilters: unknown,
  label: string,
  ordered: boolean,
  gate: LongQueryGate | undefined,
): Promise<TimedResponse> {
  const held = ordered ? gate : undefined
  const { started, hostile, normals } = await contest(server, hostileBody, normalFilters, label, held)
  const answered = await hostile
  for (const normal of normals) {
    expect({ status: normal.status, answered: (normal.hits ?? 0) > 0 }, label).toEqual({ status: 200, answered: true })
  }
  const answeredFirst = normals.filter(normal => normal.endedAt < answered.endedAt).length
  if (ordered) expect(answeredFirst, label).toBe(server.requestThreads)
  if (held !== undefined) {
    const report = await held.report()
    expect(report.movedSinceClosed, label).toBeGreaterThanOrEqual(1)
    expect(report.longQuery, label).toBeGreaterThan(Math.max(0, ...report.others))
  }
  const { endedAt, ...answer } = answered
  return { ...answer, elapsedMs: endedAt - started }
}

export async function expectServedWhileHostile(
  server: PatternServer,
  hostileBody: unknown,
  normalFilters: unknown,
  label: string,
  answersAsFastAsANormalSearch = false,
  gate?: LongQueryGate,
): Promise<TimedResponse> {
  if (server.requestThreads > 0) {
    return expectOtherThreadsAnswerFirst(server, hostileBody, normalFilters, label, !answersAsFastAsANormalSearch, gate)
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
