import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createNarsil, type EmbeddingAdapter, type Narsil } from '@delali/narsil'
import { createServer, type NarsilServer } from '@delali/narsil/server'
import type { UIMessage } from 'ai'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAskResponse } from '../src/lib/ask/answer'
import type { LlmProviderConfig } from '../src/lib/ask/config'
import { parseAskRequest } from '../src/lib/ask/messages'
import { NarsilServerClient } from '../src/lib/narsil-server-client'
import { RestBackend } from '../src/lib/rest-backend'

const DIMENSIONS = 8

/** Deterministic embedding so vector search runs without any provider. */
function vectorFor(input: string): Float32Array {
  const vector = new Float32Array(DIMENSIONS)
  for (let i = 0; i < input.length; i++) {
    vector[input.charCodeAt(i) % DIMENSIONS] += 1
  }
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < DIMENSIONS; i++) vector[i] /= norm
  return vector
}

const stubAdapter: EmbeddingAdapter = {
  dimensions: DIMENSIONS,
  async embed(input) {
    return vectorFor(input)
  },
  async embedBatch(inputs) {
    return inputs.map(vectorFor)
  },
}

interface LlmCall {
  stream: boolean
  messages: Array<{ role: string; content: string }>
}

interface StubLlm {
  server: http.Server
  baseUrl: string
  calls: LlmCall[]
  rewriteReply: string
  streamedAnswer: string[]
}

function startStubLlm(): Promise<StubLlm> {
  const stub: StubLlm = {
    server: http.createServer(),
    baseUrl: '',
    calls: [],
    rewriteReply: 'standalone rewritten query',
    streamedAnswer: ['The handbook covers ', 'incident response [1].'],
  }

  stub.server.on('request', (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        stream?: boolean
        messages: Array<{ role: string; content: string }>
      }
      stub.calls.push({ stream: body.stream === true, messages: body.messages })

      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const frame = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
        frame({
          id: 'chatcmpl-stub',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'stub-model',
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        })
        for (const piece of stub.streamedAnswer) {
          frame({
            id: 'chatcmpl-stub',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'stub-model',
            choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
          })
        }
        frame({
          id: 'chatcmpl-stub',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'stub-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-stub',
          object: 'chat.completion',
          created: 0,
          model: 'stub-model',
          choices: [{ index: 0, message: { role: 'assistant', content: stub.rewriteReply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
    })
  })

  return new Promise(resolve => {
    stub.server.listen(0, '127.0.0.1', () => {
      const { port } = stub.server.address() as AddressInfo
      stub.baseUrl = `http://127.0.0.1:${port}/v1`
      resolve(stub)
    })
  })
}

const DOCS = [
  { id: 'doc-1', title: 'Incident response', text: 'Every incident gets a severity, an owner, and a timeline.' },
  { id: 'doc-2', title: 'Release process', text: 'Releases ship weekly after the verification suite passes.' },
  { id: 'doc-3', title: 'Onboarding guide', text: 'New engineers pair for two weeks and read the handbook.' },
]

function userMessage(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

function assistantMessage(id: string, text: string): UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] }
}

interface StreamedChunk {
  type: string
  [key: string]: unknown
}

async function readUiChunks(response: Response): Promise<StreamedChunk[]> {
  expect(response.body).not.toBeNull()
  const text = await new Response(response.body).text()
  const chunks: StreamedChunk[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
    chunks.push(JSON.parse(line.slice(6)) as StreamedChunk)
  }
  return chunks
}

function textOfChunks(chunks: StreamedChunk[]): string {
  return chunks
    .filter(chunk => chunk.type === 'text-delta')
    .map(chunk => String(chunk.delta))
    .join('')
}

describe('ask pipeline against a live Narsil server', () => {
  let engine: Narsil
  let narsilServer: NarsilServer
  let backend: RestBackend
  let llm: StubLlm
  let llmConfig: LlmProviderConfig

  beforeAll(async () => {
    engine = await createNarsil()
    narsilServer = createServer(engine, {
      host: '127.0.0.1',
      port: 0,
      embeddingAdapters: { openai: stubAdapter },
    })
    await narsilServer.listen()
    const config = { baseUrl: `http://127.0.0.1:${narsilServer.listeningPort}` }

    const client = new NarsilServerClient(config)
    await client.createIndex('handbook', {
      schema: { title: 'string', text: 'string', embedding: `vector[${DIMENSIONS}]` },
      language: 'english',
      embedding: { fields: { embedding: ['title', 'text'] }, adapter: 'openai' },
    })
    const inserted = await client.insertBatchSerialized(
      'handbook',
      DOCS.map(doc => JSON.stringify(doc)),
    )
    expect(inserted.failed).toHaveLength(0)

    await client.createIndex('keyword-only', {
      schema: { title: 'string', text: 'string' },
      language: 'english',
    })

    backend = new RestBackend(config)
    llm = await startStubLlm()
    llmConfig = { apiKey: 'stub-key', baseUrl: llm.baseUrl, model: 'stub-model' }
  })

  afterAll(async () => {
    await narsilServer.close()
    await engine.shutdown()
    llm.server.close()
  })

  async function ask(body: unknown): Promise<StreamedChunk[]> {
    const request = parseAskRequest(body)
    const response = createAskResponse(backend, llmConfig, request, new AbortController().signal)
    expect(response.status).toBe(200)
    return readUiChunks(response)
  }

  it('streams sources before the answer in keyword mode', async () => {
    const chunks = await ask({
      indexName: 'handbook',
      mode: 'keyword',
      messages: [userMessage('m1', 'How does incident response work?')],
    })

    const sourcesIndex = chunks.findIndex(chunk => chunk.type === 'data-ask-sources')
    const firstTextIndex = chunks.findIndex(chunk => chunk.type === 'text-delta')
    expect(sourcesIndex).toBeGreaterThanOrEqual(0)
    expect(firstTextIndex).toBeGreaterThan(sourcesIndex)

    const data = chunks[sourcesIndex].data as {
      mode: string
      query: string
      sources: Array<{ rank: number; docId: string; title: string; snippet: string }>
    }
    expect(data.mode).toBe('keyword')
    expect(data.query).toBe('How does incident response work?')
    expect(data.sources.length).toBeGreaterThan(0)
    expect(data.sources[0].rank).toBe(1)
    expect(data.sources[0].title).toBe('Incident response')
    expect(data.sources[0].snippet).toContain('<mark>')

    expect(textOfChunks(chunks)).toBe('The handbook covers incident response [1].')
  })

  it('answers in semantic and hybrid modes via server-side query embedding', async () => {
    for (const mode of ['semantic', 'hybrid'] as const) {
      const chunks = await ask({
        indexName: 'handbook',
        mode,
        messages: [userMessage('m1', 'How does incident response work?')],
      })
      const sources = chunks.find(chunk => chunk.type === 'data-ask-sources')
      expect(sources, `${mode} sources part`).toBeDefined()
      const data = (sources as StreamedChunk).data as { mode: string; sources: unknown[] }
      expect(data.mode).toBe(mode)
      expect(data.sources.length).toBeGreaterThan(0)
      expect(textOfChunks(chunks).length).toBeGreaterThan(0)
    }
  })

  it('skips the model and says so when retrieval finds nothing', async () => {
    const before = llm.calls.length
    const chunks = await ask({
      indexName: 'handbook',
      mode: 'keyword',
      messages: [userMessage('m1', 'zzzqqqxxyy')],
    })
    const sources = chunks.find(chunk => chunk.type === 'data-ask-sources')
    expect(((sources as StreamedChunk).data as { sources: unknown[] }).sources).toHaveLength(0)
    expect(textOfChunks(chunks)).toContain('found nothing relevant')
    expect(llm.calls.length).toBe(before)
  })

  it('rewrites follow-up questions into standalone retrieval queries', async () => {
    llm.rewriteReply = 'incident response severity owner'
    const chunks = await ask({
      indexName: 'handbook',
      mode: 'keyword',
      messages: [
        userMessage('m1', 'How does incident response work?'),
        assistantMessage('m2', 'Every incident gets a severity and an owner [1].'),
        userMessage('m3', 'Who owns them?'),
      ],
    })
    const sources = chunks.find(chunk => chunk.type === 'data-ask-sources')
    const data = (sources as StreamedChunk).data as { query: string }
    expect(data.query).toBe('incident response severity owner')

    const rewriteCall = llm.calls.find(call => !call.stream)
    expect(rewriteCall).toBeDefined()
  })

  it('reports a clear error when vector modes hit an index without embeddings', async () => {
    const chunks = await ask({
      indexName: 'keyword-only',
      mode: 'semantic',
      messages: [userMessage('m1', 'anything at all')],
    })
    const errorChunk = chunks.find(chunk => chunk.type === 'error')
    expect(errorChunk).toBeDefined()
    expect(String((errorChunk as StreamedChunk).errorText)).toContain('needs vector embeddings')
  })

  it('rejects malformed requests before any retrieval', () => {
    expect(() => parseAskRequest({ indexName: 'handbook', mode: 'keyword', messages: [] })).toThrow()
    expect(() => parseAskRequest({ indexName: 'handbook', mode: 'nope', messages: [userMessage('m1', 'q')] })).toThrow()
    expect(() =>
      parseAskRequest({ indexName: '../etc', mode: 'keyword', messages: [userMessage('m1', 'q')] }),
    ).toThrow()
    expect(() =>
      parseAskRequest({
        indexName: 'handbook',
        mode: 'keyword',
        messages: [assistantMessage('m1', 'not a question')],
      }),
    ).toThrow()
  })
})
