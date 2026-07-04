import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startDemoNarsilServer } from '../demo-server'

const DIMENSIONS = 8

function vectorFor(input: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0)
  for (let i = 0; i < input.length; i++) {
    vector[input.charCodeAt(i) % DIMENSIONS] += 1
  }
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm) || 1
  return vector.map(value => value / norm)
}

interface StubEmbeddingProvider {
  server: http.Server
  baseUrl: string
  requests: number
  inputsEmbedded: number
}

/** OpenAI-compatible /embeddings endpoint with deterministic vectors, so the
 * demo bootstrap embeds documents and queries without any real provider. */
function startStubEmbeddingProvider(): Promise<StubEmbeddingProvider> {
  const stub: StubEmbeddingProvider = { server: http.createServer(), baseUrl: '', requests: 0, inputsEmbedded: 0 }
  stub.server.on('request', (req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8')
    })
    req.on('end', () => {
      const parsed = JSON.parse(body) as { input: string | string[] }
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input]
      stub.requests += 1
      stub.inputsEmbedded += inputs.length
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: inputs.map((input, index) => ({ index, embedding: vectorFor(input) })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      )
    })
  })
  return new Promise(resolve => {
    stub.server.listen(0, '127.0.0.1', () => {
      stub.baseUrl = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
      resolve(stub)
    })
  })
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined }
}

const ENV_KEYS = ['NARSIL_DATA_DIR', 'ASK_EMBEDDING_API_KEY', 'ASK_EMBEDDING_BASE_URL', 'ASK_EMBEDDING_DIMENSIONS']

describe('demo server filesystem persistence', () => {
  let dataDir: string
  let stub: StubEmbeddingProvider
  const savedEnv = new Map<string, string | undefined>()

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'narsil-demo-persistence-'))
    stub = await startStubEmbeddingProvider()
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
    process.env.NARSIL_DATA_DIR = dataDir
    process.env.ASK_EMBEDDING_API_KEY = 'test-key'
    process.env.ASK_EMBEDDING_BASE_URL = stub.baseUrl
    process.env.ASK_EMBEDDING_DIMENSIONS = String(DIMENSIONS)
  })

  afterAll(async () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await new Promise<void>(resolve => stub.server.close(() => resolve()))
    await rm(dataDir, { recursive: true, force: true })
  })

  it('recovers embedding-enabled indexes across restarts without re-embedding', async () => {
    const first = await startDemoNarsilServer()
    try {
      const created = await call(first.url, 'POST', '/indexes', {
        name: 'notes',
        config: {
          schema: { title: 'string', embedding: `vector[${DIMENSIONS}]` },
          embedding: { adapter: 'openai', fields: { embedding: ['title'] } },
        },
      })
      expect(created.status).toBe(201)

      const inserted = await call(first.url, 'POST', '/indexes/notes/documents/_batch', {
        documents: [
          { id: 'tea', title: 'green tea processing methods' },
          { id: 'ore', title: 'iron ore smelting history' },
        ],
      })
      expect(inserted.status).toBe(200)
      expect(stub.inputsEmbedded).toBe(2)

      const checkpointed = await call(first.url, 'POST', '/indexes/notes/_checkpoint')
      expect(checkpointed.status).toBe(200)
    } finally {
      await first.close()
    }

    const embeddedBeforeRestart = stub.inputsEmbedded
    const second = await startDemoNarsilServer()
    try {
      const list = await call(second.url, 'GET', '/indexes')
      expect(list.body.indexes.map((entry: { name: string }) => entry.name)).toContain('notes')

      const keyword = await call(second.url, 'POST', '/indexes/notes/search', { term: 'smelting', limit: 1 })
      expect(keyword.body.hits[0]?.id).toBe('ore')

      const semantic = await call(second.url, 'POST', '/indexes/notes/search', {
        mode: 'vector',
        vector: { field: 'embedding', text: 'green tea processing methods' },
        limit: 1,
      })
      expect(semantic.status).toBe(200)
      expect(semantic.body.hits[0]?.id).toBe('tea')

      // Recovery must reuse the stored vectors: the only new embedding call
      // is the query itself.
      expect(stub.inputsEmbedded).toBe(embeddedBeforeRestart + 1)
    } finally {
      await second.close()
    }
  })
})
