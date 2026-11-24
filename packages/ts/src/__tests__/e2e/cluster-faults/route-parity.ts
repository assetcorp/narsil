import { setTimeout as sleep } from 'node:timers/promises'
import { expect } from 'vitest'
import { send } from './workload'

export const REQUEST_TIMEOUT_MS = 60_000
const POLL_MS = 200

export interface RawReply {
  status: number
  contentType: string | null
  text: string
}

export interface Answer {
  status: number
  body: unknown
}

export async function raw(base: string, method: string, path: string, body?: string): Promise<RawReply> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/x-ndjson' },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return { status: response.status, contentType: response.headers.get('content-type'), text: await response.text() }
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function answer(base: string, method: string, path: string, body?: unknown): Promise<Answer> {
  const reply = await send(base, method, path, body, REQUEST_TIMEOUT_MS)
  return { status: reply.status, body: parsed(reply.text) }
}

export async function rawAnswer(base: string, method: string, path: string, body?: string): Promise<Answer> {
  const reply = await raw(base, method, path, body)
  return { status: reply.status, body: parsed(reply.text) }
}

export async function sameAnswer(
  bases: readonly [string, string],
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const [typescript, rust] = await Promise.all(bases.map(base => answer(base, method, path, body)))
  expect(rust, `${method} ${path}`).toEqual(typescript)
  return rust as Answer
}

export function errorCode(reply: Answer): string | undefined {
  const body = reply.body as { error?: { code?: unknown } } | null
  return typeof body?.error?.code === 'string' ? body.error.code : undefined
}

export async function countOf(base: string, indexName: string): Promise<number> {
  const reply = await answer(base, 'GET', `/indexes/${indexName}/count`)
  return reply.status === 200 ? Number((reply.body as { count?: unknown }).count) : -1
}

export async function settled<T>(
  description: string,
  timeoutMs: number,
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let latest = await read()
  while (!done(latest)) {
    if (Date.now() > deadline) {
      throw new Error(`${description} within ${timeoutMs} ms; the last reading was ${JSON.stringify(latest)}`)
    }
    await sleep(POLL_MS)
    latest = await read()
  }
  return latest
}

export async function finishedTask(base: string, accepted: Answer, timeoutMs: number): Promise<unknown> {
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(202)
  const id = (accepted.body as { id?: unknown }).id
  expect(typeof id).toBe('string')
  const record = await settled(
    `Task ${String(id)} did not finish`,
    timeoutMs,
    async () => (await answer(base, 'GET', `/tasks/${String(id)}`)).body as { status?: string },
    current => current.status !== 'running',
  )
  return record
}

export async function insertBatch(base: string, indexName: string, ids: readonly string[]): Promise<void> {
  for (let start = 0; start < ids.length; start += 500) {
    const documents = ids.slice(start, start + 500).map(id => ({ id, title: `ledger entry ${id}` }))
    const reply = await answer(base, 'POST', `/indexes/${indexName}/documents/_batch`, { documents })
    expect(reply.status, JSON.stringify(reply.body).slice(0, 2_000)).toBe(200)
    expect((reply.body as { failed?: unknown[] }).failed ?? []).toEqual([])
  }
}

export function idsOf(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, at) => `${prefix}-${String(at).padStart(5, '0')}`)
}
