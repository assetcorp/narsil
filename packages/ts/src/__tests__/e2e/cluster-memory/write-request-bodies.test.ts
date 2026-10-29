import { randomUUID } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { totalmem } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ServerLimits } from '../../../server/types'
import {
  type EtcdContainerHandle,
  MANAGED_ETCD_ENDPOINT,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from '../../distribution/coordinator/etcd-integration/fixtures'
import { errorOf, type HttpReply, type NodeProcess, request, startNodeProcess, waitFor } from './harness'

const HEAP_MEGABYTES = 192
const MEBIBYTE = 1024 * 1024
const INDEX_NAME = 'catalogue'
const PROPAGATION_TIMEOUT_MS = 20_000
const CRAFTED_BODY_BYTES = 16 * MEBIBYTE - 1024
const HONEST_BODY_BYTES = 16_000_000
const SLOW_BODY_BYTES = 8 * MEBIBYTE
const SLOW_BODIES_ALLOWED = 4.5
const SLOW_CONNECTIONS = 10
const SLOW_FIRST_CHUNK_BYTES = 64 * 1024
const SLOW_REFUSAL_WAIT_MS = 3_000
const SLOW_RELEASE_WAIT_MS = 10_000
const IMPORT_LINE_BYTES_LIMIT = 16 * MEBIBYTE
const GIANT_LINE_BYTES = 8 * MEBIBYTE
const CRATE_LINE_BYTES = 4 * MEBIBYTE
const CRATE_LINES = 4
const FURNITURE_LINES = 10
const WORDS_PER_BODY = 120
const VOCABULARY_WORDS = 20_000
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const PARSE_REASONS = ['parse_would_fill_memory', 'parse_exceeds_memory']
const MEMORY_REASONS = ['write_would_fill_memory', 'write_exceeds_memory']

interface Furniture {
  id: string
  title: string
  body: string
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

const random = createRandom(9_716)

const VOCABULARY = Array.from({ length: VOCABULARY_WORDS }, () => {
  let word = 'zq'
  for (let letter = 0; letter < 6; letter++) word += LETTERS[Math.floor(random() * LETTERS.length)]
  return word
})

function furniture(serial: number): Furniture {
  const words: string[] = []
  for (let word = 0; word < WORDS_PER_BODY; word++) words.push(VOCABULARY[Math.floor(random() * VOCABULARY.length)])
  const kind = serial % 2 === 0 ? 'Oak chair' : 'Brass lamp'
  return { id: `item-${serial}`, title: `${kind} ${serial}`, body: words.join(' ') }
}

function furnitureFilling(bytes: number): Furniture[] {
  const documents: Furniture[] = []
  let total = '{"documents":[]}'.length
  while (true) {
    const document = furniture(documents.length)
    const size = JSON.stringify(document).length + 1
    if (total + size > bytes) return documents
    documents.push(document)
    total += size
  }
}

function emptyObjects(prefix: string, bytes: number, suffix: string): string {
  const count = Math.floor((bytes - prefix.length - suffix.length + 1) / 3)
  return `${prefix}${'{},'.repeat(count - 1)}{}${suffix}`
}

function crateLine(id: string, bytes: number): string {
  return emptyObjects(`{"id":"${id}","title":"Pine crate ${id}","fill":[`, bytes, ']}')
}

function wordsOf(document: Furniture): string[] {
  return document.title.toLowerCase().split(' ')
}

async function sendText(base: string, path: string, text: string, contentType: string): Promise<HttpReply | null> {
  try {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: text,
    })
    const reply = await response.text()
    const parsed: unknown = reply.length > 0 ? JSON.parse(reply) : {}
    return {
      status: response.status,
      body: parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {},
    }
  } catch {
    return null
  }
}

function processLimitBytes(): number {
  const host = totalmem()
  const constrained = process.constrainedMemory?.() ?? 0
  return constrained > 0 && constrained < host ? constrained : host
}

async function expectAlive(node: NodeProcess): Promise<void> {
  expect(node.exited(), node.output().slice(-2_000)).toBe(false)
  expect((await request(node.base, 'GET', '/livez')).status).toBe(200)
}

async function expectSearchFindsEvery(node: NodeProcess, kept: Furniture[]): Promise<void> {
  for (const word of ['chair', 'lamp']) {
    const reply = await request(node.base, 'POST', `/indexes/${INDEX_NAME}/search`, {
      term: word,
      fields: ['title'],
      tolerance: 0,
      limit: 1,
    })
    expect(reply.body.count, word).toBe(kept.filter(document => wordsOf(document).includes(word)).length)
  }
}

interface SlowConnection {
  socket: Socket
  answer(): string
}

function openSlowConnection(base: string): Promise<SlowConnection> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    let answer = ''
    const socket = connect(Number(port), hostname, () => {
      socket.write(
        `POST /indexes/${INDEX_NAME}/documents/_batch HTTP/1.1\r\nHost: ${hostname}\r\nContent-Type: application/json\r\nContent-Length: ${SLOW_BODY_BYTES}\r\n\r\n`,
      )
      socket.write(`{"documents":[${' '.repeat(SLOW_FIRST_CHUNK_BYTES)}`)
      resolve({ socket, answer: () => answer })
    })
    socket.on('data', chunk => {
      answer += chunk.toString()
    })
    socket.on('error', () => undefined)
    socket.once('error', reject)
  })
}

describe('a cluster node with a small heap, sent request bodies that it cannot afford to parse or hold', () => {
  let container: EtcdContainerHandle | null = null
  let node: NodeProcess | null = null

  beforeAll(async () => {
    if (MANAGED_ETCD_ENDPOINT !== null) {
      container = { endpoint: MANAGED_ETCD_ENDPOINT, name: null }
      await waitForEtcdReady(MANAGED_ETCD_ENDPOINT)
    } else {
      await runDocker(['version'])
      container = await startEtcdContainer()
    }
  }, 180_000)

  afterEach(async () => {
    await node?.stop()
    node = null
  }, 60_000)

  afterAll(async () => {
    await stopEtcdContainer(container?.name ?? null)
  }, 60_000)

  async function startNode(serverLimits?: ServerLimits): Promise<NodeProcess> {
    if (container === null) throw new Error('etcd never started')
    const started = await startNodeProcess({
      nodeId: 'node-1',
      etcdEndpoint: container.endpoint,
      keyPrefix: `_narsil_request_bodies_${randomUUID()}`,
      heapMegabytes: HEAP_MEGABYTES,
      serverLimits,
    })
    node = started
    const created = await request(started.base, 'POST', '/indexes', {
      name: INDEX_NAME,
      config: { schema: { title: 'string', body: 'string' } },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    await waitFor(`${INDEX_NAME} to have an active primary`, PROPAGATION_TIMEOUT_MS, async () => {
      const reply = await request(started.base, 'GET', `/indexes/${INDEX_NAME}/cluster`)
      const partitions = (reply.body.partitions ?? []) as Array<{ primary: string | null; state: string }>
      return partitions.some(partition => partition.state === 'ACTIVE' && partition.primary !== null)
    })
    return started
  }

  it('answers 413 to a 16 MiB body of empty objects, then indexes what fits of an honest 16 MB batch', async () => {
    const started = await startNode()

    const crafted = await sendText(
      started.base,
      `/indexes/${INDEX_NAME}/documents/_batch`,
      emptyObjects('{"documents":[', CRAFTED_BODY_BYTES, ']}'),
      'application/json',
    )
    expect(crafted, started.output().slice(-2_000)).not.toBeNull()
    expect(crafted?.status).toBe(413)
    const refusal = errorOf({ status: 413, body: crafted?.body ?? {} })
    expect(refusal.code).toBe('PAYLOAD_TOO_LARGE')
    expect(refusal.details.reason).toBe('parse_exceeds_memory')
    expect(Number(refusal.details.parseBytes)).toBeGreaterThan(Number(refusal.details.blockBytes))
    await expectAlive(started)

    const documents = furnitureFilling(HONEST_BODY_BYTES)
    const honest = await sendText(
      started.base,
      `/indexes/${INDEX_NAME}/documents/_batch`,
      JSON.stringify({ documents }),
      'application/json',
    )
    expect(honest, started.output().slice(-2_000)).not.toBeNull()
    expect(honest?.status, JSON.stringify(honest?.body).slice(0, 500)).toBe(200)
    const succeeded = honest?.body.succeeded as string[]
    const failed = honest?.body.failed as Array<{
      docId: string
      error: { code: string; details?: Record<string, unknown> }
    }>
    console.log(
      `honest 16 MB batch: ${documents.length} documents, ${succeeded.length} indexed, ${failed.length} refused`,
    )
    expect(succeeded.length + failed.length).toBe(documents.length)
    expect(succeeded.length).toBeGreaterThan(0)
    for (const failure of failed) {
      expect(failure.error.code).toBe('CLUSTER_WRITE_BLOCKED')
      expect(failure.error.details?.reason).toBe('write_would_fill_memory')
    }
    const byId = new Map(documents.map(document => [document.id, document]))
    const kept = succeeded.map(docId => {
      const document = byId.get(docId)
      if (document === undefined) throw new Error(`the node acknowledged ${docId}, which the batch never held`)
      return document
    })
    expect((await request(started.base, 'GET', `/indexes/${INDEX_NAME}/count`)).body.count).toBe(kept.length)
    await expectSearchFindsEvery(started, kept)
    await expectAlive(started)
  }, 240_000)

  it('fails the NDJSON lines that it cannot afford to parse and imports the rest', async () => {
    const started = await startNode({ maxLineBytes: IMPORT_LINE_BYTES_LIMIT })
    const documents = Array.from({ length: FURNITURE_LINES }, (_, serial) => furniture(serial))
    const lines = [
      ...documents.map(document => JSON.stringify(document)),
      crateLine('crate-giant', GIANT_LINE_BYTES),
      ...Array.from({ length: CRATE_LINES }, (_, serial) => crateLine(`crate-${serial}`, CRATE_LINE_BYTES)),
    ]
    const giantLine = FURNITURE_LINES + 1

    const reply = await sendText(
      started.base,
      `/indexes/${INDEX_NAME}/documents/_import`,
      lines.join('\n'),
      'application/x-ndjson',
    )
    expect(reply, started.output().slice(-2_000)).not.toBeNull()
    expect(reply?.status, JSON.stringify(reply?.body).slice(0, 500)).toBe(200)
    const indexed = Number(reply?.body.indexed)
    const errors = reply?.body.errors as Array<{ line?: number; code: string; details?: Record<string, unknown> }>
    console.log(
      `import: ${indexed} indexed, ${String(reply?.body.failed)} failed, ${JSON.stringify(errors.map(error => [error.line, error.code, error.details?.reason]))}`,
    )
    expect(indexed + Number(reply?.body.failed)).toBe(lines.length)
    expect(errors.find(error => error.line === giantLine)).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      details: { reason: 'parse_exceeds_memory' },
    })
    expect(errors.some(error => error.details?.reason === 'parse_would_fill_memory')).toBe(true)
    for (const error of errors) {
      expect([...PARSE_REASONS, ...MEMORY_REASONS]).toContain(error.details?.reason)
    }
    expect((await request(started.base, 'GET', `/indexes/${INDEX_NAME}/count`)).body.count).toBe(indexed)
    await expectSearchFindsEvery(started, documents)
    await expectAlive(started)
  }, 240_000)

  it('refuses slow bodies past its bound on bytes held, stays up, and accepts writes once they close', async () => {
    const limitBytes = SLOW_BODY_BYTES * SLOW_BODIES_ALLOWED
    const started = await startNode({ maxBodyBytesInFlightFraction: limitBytes / processLimitBytes() })

    const connections: SlowConnection[] = []
    for (let opened = 0; opened < SLOW_CONNECTIONS; opened++) connections.push(await openSlowConnection(started.base))
    await sleep(SLOW_REFUSAL_WAIT_MS)
    const refused = connections.filter(connection => connection.answer().startsWith('HTTP/1.1 429'))
    const waiting = connections.filter(connection => connection.answer().length === 0)
    console.log(`slow bodies: ${refused.length} refused, ${waiting.length} still sending of ${SLOW_CONNECTIONS}`)
    expect(waiting.length).toBe(Math.floor(SLOW_BODIES_ALLOWED))
    expect(refused.length).toBe(SLOW_CONNECTIONS - waiting.length)
    for (const connection of refused) {
      expect(connection.answer()).toContain('"code":"TOO_MANY_REQUESTS"')
      expect(connection.answer()).toContain('"reason":"request_bytes_in_flight"')
    }
    await expectAlive(started)

    for (const connection of connections) connection.socket.destroy()
    const documents = furnitureFilling(SLOW_BODY_BYTES)
    const latest: { reply: HttpReply | null } = { reply: null }
    await waitFor('the node to accept a full body once the slow bodies close', SLOW_RELEASE_WAIT_MS, async () => {
      latest.reply = await sendText(
        started.base,
        `/indexes/${INDEX_NAME}/documents/_batch`,
        JSON.stringify({ documents }),
        'application/json',
      )
      return latest.reply?.status === 200
    })
    const failed = (latest.reply?.body.failed ?? []) as Array<{ error: { details?: Record<string, unknown> } }>
    for (const failure of failed) expect(MEMORY_REASONS).toContain(failure.error.details?.reason)
    await expectAlive(started)
  }, 240_000)
})
