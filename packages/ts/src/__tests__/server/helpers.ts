import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilServer, ServerOptions } from '../../server'
import { createServer } from '../../server'
import type { NarsilConfig } from '../../types/config'

export interface TestServer {
  engine: Narsil
  server: NarsilServer
  base: string
  stop(): Promise<void>
}

export async function startTestServer(
  options?: Omit<ServerOptions, 'host' | 'port'>,
  config?: NarsilConfig,
  prepare?: (engine: Narsil) => Promise<void>,
): Promise<TestServer> {
  const engine = await createNarsil(config)
  await prepare?.(engine)
  const server = createServer(engine, { host: '127.0.0.1', port: 0, ...options })
  await server.listen()
  const base = `http://127.0.0.1:${server.listeningPort}`
  return {
    engine,
    server,
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

export async function waitFor(condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

export async function scaledOut(engine: Narsil, indexName: string): Promise<boolean> {
  const stats = await engine.getMemoryStats()
  return stats.workerCopies.some(copy => copy.indexName === indexName && copy.scaledOut)
}
