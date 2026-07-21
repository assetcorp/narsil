import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
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

interface OpenAiMessage {
  role: string
  content: unknown
}

interface LlmCall {
  messages: OpenAiMessage[]
}

interface StubLlm {
  server: http.Server
  baseUrl: string
  calls: LlmCall[]
  streamedAnswer: string[]
}

function messageContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .join('')
  }
  return ''
}

function lastUserQuery(messages: OpenAiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messageContentText(messages[i].content)
  }
  return ''
}

/** The agent hands search results back to the model as a `tool` message; the
 * stub reads the candidate docIds out of it, in ranking order, so its
 * readDocument calls target real documents without hard-coding engine-assigned
 * ids. */
function candidateDocIds(messages: OpenAiMessage[]): string[] {
  const searchMessage = messages.find(
    message => message.role === 'tool' && JSON.stringify(message).includes('"results"'),
  )
  if (!searchMessage) return []
  const ids: string[] = []
  const pattern = /"docId":"([^"]+)"/g
  const serialized = JSON.stringify(searchMessage)
  let match = pattern.exec(serialized)
  while (match) {
    if (!ids.includes(match[1])) ids.push(match[1])
    match = pattern.exec(serialized)
  }
  return ids
}

/**
 * A stub OpenAI Chat Completions endpoint that plays the agent loop: it emits a
 * `search` tool call on the first turn, then reads the top two distinct
 * candidates one per turn, then emits the final cited answer. When a search
 * returns nothing, it answers straight away without reading.
 */
function startStubLlm(): Promise<StubLlm> {
  const stub: StubLlm = {
    server: http.createServer(),
    baseUrl: '',
    calls: [],
    streamedAnswer: ['The handbook covers ', 'incident response [1].'],
  }

  const frame = (res: http.ServerResponse, choice: unknown): void => {
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-stub',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'stub-model',
        choices: [choice],
      })}\n\n`,
    )
  }

  const emitToolCall = (res: http.ServerResponse, name: string, args: unknown): void => {
    frame(res, { index: 0, delta: { role: 'assistant' }, finish_reason: null })
    frame(res, {
      index: 0,
      delta: { tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: '' } }] },
      finish_reason: null,
    })
    frame(res, {
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
      finish_reason: null,
    })
    frame(res, { index: 0, delta: {}, finish_reason: 'tool_calls' })
    res.write('data: [DONE]\n\n')
    res.end()
  }

  const emitAnswer = (res: http.ServerResponse): void => {
    frame(res, { index: 0, delta: { role: 'assistant' }, finish_reason: null })
    for (const piece of stub.streamedAnswer) {
      frame(res, { index: 0, delta: { content: piece }, finish_reason: null })
    }
    frame(res, { index: 0, delta: {}, finish_reason: 'stop' })
    res.write('data: [DONE]\n\n')
    res.end()
  }

  stub.server.on('request', (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: OpenAiMessage[] }
      stub.calls.push({ messages: body.messages })

      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const toolMessages = body.messages.filter(message => message.role === 'tool')

      if (toolMessages.length === 0) {
        emitToolCall(res, 'search', { query: lastUserQuery(body.messages) })
        return
      }
      const readCount = toolMessages.length - 1
      const docIds = candidateDocIds(body.messages)
      if (readCount < 2 && docIds[readCount]) {
        emitToolCall(res, 'readDocument', { docId: docIds[readCount] })
        return
      }
      emitAnswer(res)
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

describe('agentic ask pipeline against a live Narsil server', () => {
  let engine: Narsil
  let narsilServer: NarsilServer
  let backend: RestBackend
  let llm: StubLlm
  let llmConfig: LlmProviderConfig
  let tempChatDir: string

  beforeAll(async () => {
    tempChatDir = mkdtempSync(path.join(tmpdir(), 'ask-pipeline-chat-'))
    process.env.ASK_CHAT_DB_PATH = path.join(tempChatDir, 'chat.db')
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
    llmConfig = { apiKey: 'stub-key', baseUrl: llm.baseUrl, model: 'stub-model', titleModel: 'stub-model' }
  })

  afterAll(async () => {
    await narsilServer.close()
    await engine.shutdown()
    llm.server.close()
    if (tempChatDir) rmSync(tempChatDir, { recursive: true, force: true })
  })

  async function ask(body: unknown): Promise<StreamedChunk[]> {
    const request = parseAskRequest({ threadId: 'pipeline-thread', ...(body as Record<string, unknown>) })
    const response = createAskResponse(backend, llmConfig, request, new AbortController().signal)
    expect(response.status).toBe(200)
    return readUiChunks(response)
  }

  it('searches, reads the top candidate, then answers with opened-doc sources in keyword mode', async () => {
    const before = llm.calls.length
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
    // At least search, one read, and the answer run as separate model steps.
    expect(llm.calls.length - before).toBeGreaterThanOrEqual(3)
  })

  it('reads several distinct documents before answering when the search returns many', async () => {
    for (const mode of ['semantic', 'hybrid'] as const) {
      const chunks = await ask({
        indexName: 'handbook',
        mode,
        messages: [userMessage('m1', 'How does incident response work?')],
      })
      const sources = chunks.find(chunk => chunk.type === 'data-ask-sources')
      expect(sources, `${mode} sources part`).toBeDefined()
      const data = (sources as StreamedChunk).data as { mode: string; sources: Array<{ rank: number }> }
      expect(data.mode).toBe(mode)
      // The loop reads at least two distinct documents, so the answer is never grounded on one.
      expect(data.sources.length).toBeGreaterThanOrEqual(2)
      expect(data.sources.map(source => source.rank)).toEqual(data.sources.map((_source, index) => index + 1))
      expect(textOfChunks(chunks).length).toBeGreaterThan(0)
    }
  })

  it('answers without opening any document when the search finds nothing', async () => {
    const before = llm.calls.length
    const chunks = await ask({
      indexName: 'handbook',
      mode: 'keyword',
      messages: [userMessage('m1', 'zzzqqqxxyy')],
    })
    expect(chunks.find(chunk => chunk.type === 'data-ask-sources')).toBeUndefined()
    expect(textOfChunks(chunks).length).toBeGreaterThan(0)
    // search returns nothing, so the model skips readDocument: one search step plus the answer.
    expect(llm.calls.length - before).toBe(2)
  })

  it('reports a clear error when vector modes hit an index without embeddings', async () => {
    const before = llm.calls.length
    const chunks = await ask({
      indexName: 'keyword-only',
      mode: 'semantic',
      messages: [userMessage('m1', 'anything at all')],
    })
    const errorChunk = chunks.find(chunk => chunk.type === 'error')
    expect(errorChunk).toBeDefined()
    expect(String((errorChunk as StreamedChunk).errorText)).toContain('needs vector embeddings')
    // The mode is rejected before any model call.
    expect(llm.calls.length).toBe(before)
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
