import { createNarsil, type Narsil } from '../../narsil'
import type { ServerOptions } from '../../server'
import { createServer } from '../../server'

export interface TestServer {
  engine: Narsil
  base: string
  stop(): Promise<void>
}

export async function startTestServer(options?: Omit<ServerOptions, 'host' | 'port'>): Promise<TestServer> {
  const engine = await createNarsil()
  const server = createServer(engine, { host: '127.0.0.1', port: 0, ...options })
  await server.listen()
  const base = `http://127.0.0.1:${server.listeningPort}`
  return {
    engine,
    base,
    async stop() {
      await server.close()
      await engine.shutdown()
    },
  }
}

export interface HttpResult<T = unknown> {
  status: number
  body: T
}

async function readResult<T>(res: Response): Promise<HttpResult<T>> {
  const text = await res.text()
  const body = text.length > 0 ? (JSON.parse(text) as T) : (undefined as T)
  return { status: res.status, body }
}

export async function postJson<T = unknown>(base: string, path: string, body: unknown): Promise<HttpResult<T>> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return readResult<T>(res)
}

export async function putJson<T = unknown>(base: string, path: string, body: unknown): Promise<HttpResult<T>> {
  const res = await fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return readResult<T>(res)
}

export async function patchJson<T = unknown>(base: string, path: string, body: unknown): Promise<HttpResult<T>> {
  const res = await fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return readResult<T>(res)
}

export async function getJson<T = unknown>(base: string, path: string): Promise<HttpResult<T>> {
  const res = await fetch(`${base}${path}`)
  return readResult<T>(res)
}

export async function del<T = unknown>(base: string, path: string): Promise<HttpResult<T>> {
  const res = await fetch(`${base}${path}`, { method: 'DELETE' })
  return readResult<T>(res)
}

export async function postRaw<T = unknown>(
  base: string,
  path: string,
  body: string | Uint8Array,
  contentType: string,
): Promise<HttpResult<T>> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: body as BodyInit,
  })
  return readResult<T>(res)
}

export function toNdjson(docs: Array<Record<string, unknown>>): string {
  return docs.map(d => JSON.stringify(d)).join('\n')
}
