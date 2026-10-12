import { createNarsilClient, type NarsilClient } from '../../../client'
import type { ServerOptions } from '../../../server'
import type { NarsilConfig } from '../../../types/config'
import { startTestServer, type TestServer } from '../../server/helpers'

export interface DocumentServer {
  readonly server: TestServer
  readonly client: NarsilClient
  readonly base: string
}

const running: TestServer[] = []

export async function startDocumentServer(
  config: NarsilConfig = { workers: { enabled: false } },
  options?: Omit<ServerOptions, 'host' | 'port'>,
): Promise<DocumentServer> {
  const server = await startTestServer(options, config)
  running.push(server)
  return { server, client: createNarsilClient({ url: server.base }), base: server.base }
}

export async function stopDocumentServers(): Promise<void> {
  for (const server of running.splice(0)) await server.stop()
}

export function errorCodeOf(body: unknown): string | null {
  return (body as { error?: { code?: string } } | undefined)?.error?.code ?? null
}

export function errorFieldOf(body: unknown): unknown {
  return (body as { error?: { details?: { field?: unknown } } } | undefined)?.error?.details?.field
}

export async function sendRaw(
  base: string,
  method: string,
  path: string,
  body?: string,
  contentType = 'application/json',
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': contentType },
    body,
  })
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}
