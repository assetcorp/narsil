import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createNarsilClient, isNarsilError, type NarsilClient } from '../../../client'
import {
  type EtcdContainerHandle,
  MANAGED_ETCD_ENDPOINT,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from '../../distribution/coordinator/etcd-integration/fixtures'
import { errorOf, isServerMemoryRefusal, type NodeProcess, request, startNodeProcess, waitFor } from './harness'

const HEAP_MEGABYTES = 128
const NODE_IDS = ['node-1', 'node-2']
const INDEX_NAMES = ['catalogue']
const BATCH_DOCUMENTS = 2_000
const FILL_SEND_BUDGET_HEAP_LIMITS = 3
const WORDS_PER_BODY = 120
const VOCABULARY_WORDS = 20_000
const READ_DOCUMENTS = 10_000
const READ_ROUNDS = 2
const CONCURRENT_COPIES = 3
const REQUEST_TIMEOUT_MS = 120_000
const PROPAGATION_TIMEOUT_MS = 20_000
const MEMORY_REFUSAL_REASONS = ['response_would_fill_memory', 'parse_would_fill_memory', 'request_bytes_in_flight']

interface Furniture {
  title: string
  body: string
}

interface ReadOutcomes {
  answered: number
  refused: Array<Record<string, unknown>>
  cut: number
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

const random = createRandom(83)
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const VOCABULARY = Array.from({ length: VOCABULARY_WORDS }, () => {
  let word = 'zq'
  for (let letter = 0; letter < 6; letter++) word += LETTERS[Math.floor(random() * LETTERS.length)]
  return word
})

function furnitureNumber(serial: number): Furniture {
  const words: string[] = []
  for (let word = 0; word < WORDS_PER_BODY; word++) words.push(VOCABULARY[Math.floor(random() * VOCABULARY.length)])
  return { title: `${serial % 2 === 0 ? 'Oak chair' : 'Brass lamp'} ${serial}`, body: words.join(' ') }
}

function chairsIn(oracle: ReadonlyMap<string, Furniture>): number {
  let chairs = 0
  for (const document of oracle.values()) if (document.title.startsWith('Oak chair ')) chairs++
  return chairs
}

function expectFurniture(docId: string, document: unknown, oracle: ReadonlyMap<string, Furniture>): void {
  const expected = oracle.get(docId)
  if (expected === undefined) throw new Error(`${docId} came back although no node acknowledged it`)
  const { title, body } = document as Partial<Furniture>
  if (title !== expected.title || body !== expected.body) {
    throw new Error(`${docId} came back as ${JSON.stringify({ title, body }).slice(0, 200)}`)
  }
}

async function primaryOf(node: NodeProcess, indexName: string): Promise<string | null> {
  const reply = await request(node.base, 'GET', `/indexes/${indexName}/cluster`)
  const partitions = (reply.body.partitions ?? []) as Array<{ primary: string | null; state: string }>
  return partitions.find(partition => partition.state === 'ACTIVE')?.primary ?? null
}

async function fillUntilBlocked(node: NodeProcess, indexName: string, firstSerial: number) {
  const oracle = new Map<string, Furniture>()
  let serial = firstSerial
  let sentBytes = 0
  while (sentBytes < node.heapLimitBytes * FILL_SEND_BUDGET_HEAP_LIMITS) {
    const documents = Array.from({ length: BATCH_DOCUMENTS }, () => ({
      id: `item-${serial}`,
      ...furnitureNumber(serial++),
    }))
    sentBytes += JSON.stringify({ documents }).length
    const reply = await request(node.base, 'POST', `/indexes/${indexName}/documents/_batch`, { documents })
    if (reply.status === 429) {
      if (!isServerMemoryRefusal(reply)) expect(errorOf(reply).code).toBe('CLUSTER_WRITE_BLOCKED')
      return oracle
    }
    expect(reply.status, JSON.stringify(reply.body).slice(0, 500)).toBe(200)
    const byId = new Map(documents.map(({ id, ...document }) => [id, document]))
    for (const docId of reply.body.succeeded as string[]) {
      const document = byId.get(docId)
      if (document === undefined) throw new Error(`the node acknowledged ${docId}, which the batch never held`)
      oracle.set(docId, document)
    }
    if ((reply.body.failed as unknown[]).length > 0) return oracle
  }
  throw new Error(`${node.nodeId} blocked no write to ${indexName} after ${sentBytes} bytes`)
}

async function settle(read: () => Promise<void>, outcomes: ReadOutcomes): Promise<void> {
  try {
    await read()
    outcomes.answered++
  } catch (err) {
    if (!isNarsilError(err)) throw err
    if (err.code === 'CLIENT_CONNECTION_FAILED') {
      outcomes.cut++
      return
    }
    expect(err.code, err.message).toBe('TOO_MANY_REQUESTS')
    expect(MEMORY_REFUSAL_REASONS, err.message).toContain(err.details.reason)
    outcomes.refused.push(err.details)
  }
}

function readsThrough(client: NarsilClient, indexName: string, oracle: ReadonlyMap<string, Furniture>) {
  const docIds = [...oracle.keys()].slice(0, READ_DOCUMENTS)
  return [
    async () => {
      const found = await client.getMultiple(indexName, docIds)
      expect(found.size).toBe(docIds.length)
      for (const docId of docIds) expectFurniture(docId, found.get(docId), oracle)
    },
    async () => {
      const page = await client.listDocuments(indexName, { limit: READ_DOCUMENTS })
      expect(page.total).toBe(oracle.size)
      expect(page.documents.length).toBe(Math.min(READ_DOCUMENTS, oracle.size))
      const ids = page.documents.map(listed => listed.id)
      expect(ids).toEqual([...oracle.keys()].sort().slice(0, READ_DOCUMENTS))
      for (const listed of page.documents) expectFurniture(listed.id, listed.document, oracle)
    },
    async () => {
      const result = await client.query(indexName, { term: 'chair', limit: READ_DOCUMENTS })
      expect(result.count).toBe(chairsIn(oracle))
      expect(result.hits.length).toBe(Math.min(READ_DOCUMENTS, chairsIn(oracle)))
      for (const hit of result.hits) expectFurniture(hit.id, hit.document, oracle)
    },
  ]
}

describe('a two-process cluster whose nodes answer reads larger than their free memory', () => {
  let container: EtcdContainerHandle | null = null
  let nodes: NodeProcess[] = []

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
    await Promise.all(nodes.map(node => node.stop()))
    nodes = []
  }, 60_000)

  afterAll(async () => {
    await stopEtcdContainer(container?.name ?? null)
  }, 60_000)

  it('answers or refuses with a typed error every read that crosses nodes, and every node stays up', async () => {
    if (container === null) throw new Error('etcd never started')
    const keyPrefix = `_narsil_read_answers_${randomUUID()}`
    for (const nodeId of NODE_IDS) {
      nodes.push(
        await startNodeProcess({ nodeId, etcdEndpoint: container.endpoint, keyPrefix, heapMegabytes: HEAP_MEGABYTES }),
      )
    }
    const entry = nodes[0]
    await waitFor('every node to see the other', PROPAGATION_TIMEOUT_MS, async () => {
      for (const node of nodes) {
        const reply = await request(node.base, 'GET', '/cluster')
        if (((reply.body.nodes ?? []) as unknown[]).length !== NODE_IDS.length) return false
      }
      return true
    })

    const filled: Array<{
      indexName: string
      holder: NodeProcess
      reader: NodeProcess
      oracle: Map<string, Furniture>
    }> = []
    for (const [position, indexName] of INDEX_NAMES.entries()) {
      const created = await request(entry.base, 'POST', '/indexes', {
        name: indexName,
        config: { schema: { title: 'string', body: 'string' } },
      })
      expect(created.status, JSON.stringify(created.body)).toBe(201)
      let primary: string | null = null
      await waitFor(`${indexName} to have an active primary`, PROPAGATION_TIMEOUT_MS, async () => {
        primary = await primaryOf(entry, indexName)
        return primary !== null
      })
      const holder = nodes.find(node => node.nodeId === primary)
      const reader = nodes.find(node => node.nodeId !== primary)
      if (holder === undefined || reader === undefined) throw new Error(`${indexName} has no primary`)
      const oracle = await fillUntilBlocked(holder, indexName, position * 1_000_000)
      expect(oracle.size).toBeGreaterThan(0)
      filled.push({ indexName, holder, reader, oracle })
    }

    const outcomes: ReadOutcomes = { answered: 0, refused: [], cut: 0 }
    for (let round = 0; round < READ_ROUNDS; round++) {
      const reads = filled.flatMap(({ indexName, reader, oracle }) =>
        readsThrough(createNarsilClient({ url: reader.base, timeoutMs: REQUEST_TIMEOUT_MS }), indexName, oracle),
      )
      const copies = Array.from({ length: CONCURRENT_COPIES }, () => reads).flat()
      const settled = await Promise.allSettled(copies.map(read => settle(read, outcomes)))
      for (const node of nodes) expect(node.exited(), node.output().slice(-3_000)).toBe(false)
      for (const result of settled) if (result.status === 'rejected') throw result.reason
    }
    console.log(
      `cluster reads: ${filled.map(({ indexName, holder, oracle }) => `${indexName} on ${holder.nodeId} holds ${oracle.size}`).join(', ')}; ${outcomes.answered} answered, ${outcomes.refused.length} refused, ${outcomes.cut} cut ${JSON.stringify(outcomes.refused[0] ?? null)}`,
    )
    for (const node of nodes) expect(node.exited(), node.output().slice(-3_000)).toBe(false)
    expect(outcomes.answered).toBeGreaterThan(0)
  }, 300_000)
})
