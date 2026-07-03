import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { createServer, type NarsilServer } from '../../server'
import type { EmbeddingAdapter } from '../../types/adapters'
import { postJson } from './helpers'

const DIMENSIONS = 4

interface CountingAdapter {
  adapter: EmbeddingAdapter
  counts: { document: number; query: number }
}

function countingAdapter(): CountingAdapter {
  const counts = { document: 0, query: 0 }
  const adapter: EmbeddingAdapter = {
    dimensions: DIMENSIONS,
    async embed(input: string, purpose: 'document' | 'query'): Promise<Float32Array> {
      counts[purpose] += 1
      const vector = new Float32Array(DIMENSIONS)
      for (let i = 0; i < input.length; i += 1) {
        vector[i % DIMENSIONS] += input.charCodeAt(i)
      }
      let norm = 0
      for (const component of vector) norm += component * component
      norm = Math.sqrt(norm) || 1
      for (let i = 0; i < DIMENSIONS; i += 1) vector[i] /= norm
      return vector
    },
  }
  return { adapter, counts }
}

const CREATE_REQUEST = {
  name: 'articles',
  config: {
    schema: { title: 'string', embedding: `vector[${DIMENSIONS}]` },
    embedding: { adapter: 'stub', fields: { embedding: ['title'] } },
  },
}

interface QueryResponse {
  hits: Array<{ id: string }>
}

describe('named embedding adapters over REST with durability', () => {
  let dir: string
  let engine: Narsil | null = null
  let server: NarsilServer | null = null
  let base = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-server-embed-'))
  })

  afterEach(async () => {
    await stopAll()
    await rm(dir, { recursive: true, force: true })
  })

  async function stopAll(): Promise<void> {
    if (server) {
      await server.close()
      server = null
    }
    if (engine) {
      await engine.shutdown()
      engine = null
    }
  }

  async function startServer(adapter: EmbeddingAdapter): Promise<void> {
    engine = await createNarsil({ durability: { directory: dir } })
    server = createServer(engine, { host: '127.0.0.1', port: 0, embeddingAdapters: { stub: adapter } })
    await server.listen()
    base = `http://127.0.0.1:${server.listeningPort}`
  }

  it('creates by adapter name, embeds at insert, and answers text queries after a restart', async () => {
    const first = countingAdapter()
    await startServer(first.adapter)

    const created = await postJson(base, '/indexes', CREATE_REQUEST)
    expect(created.status).toBe(201)

    const inserted = await postJson(base, '/indexes/articles/documents/_batch', {
      documents: [
        { id: 'a', title: 'volcanic islands of the pacific' },
        { id: 'b', title: 'medieval trade routes in europe' },
      ],
    })
    expect(inserted.status).toBe(200)
    expect(first.counts.document).toBe(2)

    const beforeRestart = await postJson<QueryResponse>(base, '/indexes/articles/search', {
      mode: 'vector',
      vector: { field: 'embedding', text: 'medieval trade routes in europe' },
      limit: 1,
    })
    expect(beforeRestart.status).toBe(200)
    expect(beforeRestart.body.hits[0]?.id).toBe('b')

    await stopAll()

    const second = countingAdapter()
    await startServer(second.adapter)

    const afterRestart = await postJson<QueryResponse>(base, '/indexes/articles/search', {
      mode: 'vector',
      vector: { field: 'embedding', text: 'volcanic islands of the pacific' },
      limit: 1,
    })
    expect(afterRestart.status).toBe(200)
    expect(afterRestart.body.hits[0]?.id).toBe('a')
    expect(second.counts.query).toBe(1)
    expect(second.counts.document).toBe(0)
  })

  it('rejects an unknown adapter name with the registered names listed', async () => {
    await startServer(countingAdapter().adapter)

    const created = await postJson<{ error: { message: string } }>(base, '/indexes', {
      name: 'articles',
      config: {
        ...CREATE_REQUEST.config,
        embedding: { adapter: 'missing', fields: { embedding: ['title'] } },
      },
    })
    expect(created.status).toBeGreaterThanOrEqual(400)
    expect(created.status).toBeLessThan(500)
    expect(JSON.stringify(created.body)).toContain('missing')
    expect(JSON.stringify(created.body)).toContain('stub')
  })
})
