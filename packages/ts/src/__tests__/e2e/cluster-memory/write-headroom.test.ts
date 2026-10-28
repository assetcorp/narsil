import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type EtcdContainerHandle,
  MANAGED_ETCD_ENDPOINT,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from '../../distribution/coordinator/etcd-integration/fixtures'
import {
  errorOf,
  expectEveryDocumentReadsBack,
  isServerMemoryRefusal,
  type NodeProcess,
  request,
  startNodeProcess,
  waitFor,
} from './harness'

const HEAP_MEGABYTES = 192
const INDEX_NAME = 'catalogue'
const PROPAGATION_TIMEOUT_MS = 20_000
const BATCH_DOCUMENTS = 2_000
const SEND_BUDGET_HEAP_LIMITS = 3
const WORDS_PER_BODY = 120
const VOCABULARY_WORDS = 20_000
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const VECTOR_DIMENSION = 1_536
const VECTOR_BATCH_DOCUMENTS = 250
const VECTOR_SEND_BUDGET_DOCUMENTS = 60_000
const CAPPED_HEAP_BLOCK_FRACTION = 0.75
const VECTOR_BATCH_HEAP_FRACTION = 0.1
const VECTOR_BOUND_OVER_HEAP_MAX_RATIO = 155
const HEAP_SAMPLE_INTERVAL_MS = 20

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

const random = createRandom(97)

const VOCABULARY = Array.from({ length: VOCABULARY_WORDS }, () => {
  let word = 'zq'
  for (let letter = 0; letter < 6; letter++) word += LETTERS[Math.floor(random() * LETTERS.length)]
  return word
})

function batchOfFurniture(batch: number): Furniture[] {
  const documents: Furniture[] = []
  for (let count = 0; count < BATCH_DOCUMENTS; count++) {
    const serial = batch * BATCH_DOCUMENTS + count
    const words: string[] = []
    for (let word = 0; word < WORDS_PER_BODY; word++) words.push(VOCABULARY[Math.floor(random() * VOCABULARY.length)])
    const kind = serial % 2 === 0 ? 'Oak chair' : 'Brass lamp'
    documents.push({ id: `item-${serial}`, title: `${kind} ${serial}`, body: words.join(' ') })
  }
  return documents
}

function titledChair(document: Furniture): boolean {
  return document.title.toLowerCase().split(' ').includes('chair')
}

interface Lamp {
  id: string
  title: string
  embedding: number[]
}

function batchOfLamps(firstSerial: number, documents: number): Lamp[] {
  return Array.from({ length: documents }, (_, count) => {
    const serial = firstSerial + count
    return {
      id: `lamp-${serial}`,
      title: `Brass lamp ${serial}`,
      embedding: Array.from({ length: VECTOR_DIMENSION }, () => random() * 2 - 1),
    }
  })
}

interface BatchReply {
  status: number | null
  body: Record<string, unknown>
}

interface BatchFailure {
  docId: string
  error: { code: string; details?: Record<string, unknown> }
}

async function sendBatch(base: string, documents: Array<Furniture | Lamp>): Promise<BatchReply> {
  try {
    return await request(base, 'POST', `/indexes/${INDEX_NAME}/documents/_batch`, { documents })
  } catch {
    return { status: null, body: {} }
  }
}

async function heapUsedOf(node: NodeProcess): Promise<number> {
  const memory = await request(node.base, 'GET', '/stats/memory')
  const heapUsed = (memory.body.process as { heapUsed?: unknown } | null)?.heapUsed
  if (typeof heapUsed !== 'number') throw new Error(`the node reported no heap figure: ${JSON.stringify(memory.body)}`)
  return heapUsed
}

async function sendBatchSamplingHeap(
  node: NodeProcess,
  documents: Lamp[],
): Promise<{ reply: BatchReply; peakHeapUsed: number }> {
  let peakHeapUsed = await heapUsedOf(node)
  let sending = true
  const sampler = (async () => {
    while (sending) {
      peakHeapUsed = Math.max(peakHeapUsed, await heapUsedOf(node))
      await sleep(HEAP_SAMPLE_INTERVAL_MS)
    }
  })()
  const reply = await sendBatch(node.base, documents)
  sending = false
  await sampler
  return { reply, peakHeapUsed }
}

async function startNodeWithIndex(etcdEndpoint: string, schema: Record<string, string>): Promise<NodeProcess> {
  const started = await startNodeProcess({
    nodeId: 'node-1',
    etcdEndpoint,
    keyPrefix: `_narsil_write_headroom_${randomUUID()}`,
    heapMegabytes: HEAP_MEGABYTES,
  })
  const created = await request(started.base, 'POST', '/indexes', { name: INDEX_NAME, config: { schema } })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  await waitFor(`${INDEX_NAME} to have an active primary`, PROPAGATION_TIMEOUT_MS, async () => {
    const reply = await request(started.base, 'GET', `/indexes/${INDEX_NAME}/cluster`)
    const partitions = (reply.body.partitions ?? []) as Array<{ primary: string | null; state: string }>
    return partitions.some(partition => partition.state === 'ACTIVE' && partition.primary !== null)
  })
  return started
}

describe('a cluster node at its default memory settings, written to one batch at a time', () => {
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

  it('refuses the documents that would run it out of heap and keeps every document it acknowledged', async () => {
    if (container === null) throw new Error('etcd never started')
    const started = await startNodeWithIndex(container.endpoint, { title: 'string', body: 'string' })
    node = started

    const oracle = new Map<string, Furniture>()
    let refused = false
    let firstRefusal: unknown = null
    let sentBytes = 0
    const sendBudgetBytes = started.heapLimitBytes * SEND_BUDGET_HEAP_LIMITS
    for (let batch = 0; sentBytes < sendBudgetBytes && !refused; batch++) {
      const documents = batchOfFurniture(batch)
      sentBytes += JSON.stringify({ documents }).length
      const before = await request(started.base, 'GET', '/stats/memory')
      const sentAt = Date.now()
      const reply = await sendBatch(started.base, documents)
      console.log(
        `headroom batch ${batch}: heap ${String((before.body.process as { heapUsed?: unknown } | null)?.heapUsed)} bytes before, ` +
          `status ${String(reply.status)}, ${(reply.body.succeeded as string[] | undefined)?.length ?? 0} kept in ${Date.now() - sentAt} ms`,
      )
      expect(
        reply.status,
        `the node stopped answering after it acknowledged ${oracle.size} documents: ${started.output().slice(-2_000)}`,
      ).not.toBeNull()
      expect([200, 429], JSON.stringify(reply.body).slice(0, 500)).toContain(reply.status)
      if (reply.status === 429) {
        if (!isServerMemoryRefusal({ status: 429, body: reply.body })) {
          expect(errorOf({ status: 429, body: reply.body }).code).toBe('CLUSTER_WRITE_BLOCKED')
        }
        firstRefusal = errorOf({ status: 429, body: reply.body }).details
        refused = true
        continue
      }
      const failed = reply.body.failed as BatchFailure[]
      if (failed.length > 0) firstRefusal = failed[0].error.details
      for (const failure of failed) {
        expect(failure.error.code).toBe('CLUSTER_WRITE_BLOCKED')
        expect(failure.error.details?.reason).toBe('write_would_fill_memory')
      }
      const byId = new Map(documents.map(document => [document.id, document]))
      for (const docId of reply.body.succeeded as string[]) {
        const document = byId.get(docId)
        if (document === undefined) throw new Error(`the node acknowledged ${docId}, which the batch never held`)
        oracle.set(docId, document)
      }
      expect(oracle.size + failed.length).toBe((batch + 1) * BATCH_DOCUMENTS)
      refused = failed.length > 0
    }

    const memory = await request(started.base, 'GET', '/stats/memory')
    const heapUsed = (memory.body.process as { heapUsed?: unknown } | null)?.heapUsed
    console.log(
      `headroom: ${oracle.size} documents kept before the first refusal, heap at ${String(heapUsed)} bytes of ${started.heapLimitBytes}, first refusal ${JSON.stringify(firstRefusal)}`,
    )
    expect(
      refused,
      `the node refused nothing after ${sentBytes} bytes of documents, ${SEND_BUDGET_HEAP_LIMITS} times its heap limit`,
    ).toBe(true)
    expect(oracle.size).toBeGreaterThan(0)

    const counted = await request(started.base, 'GET', `/indexes/${INDEX_NAME}/count`)
    expect(counted.body.count).toBe(oracle.size)
    const chairs = await request(started.base, 'POST', `/indexes/${INDEX_NAME}/search`, {
      term: 'chair',
      fields: ['title'],
      tolerance: 0,
      limit: 5,
    })
    expect(chairs.body.count).toBe([...oracle.values()].filter(titledChair).length)
    await expectEveryDocumentReadsBack(started.base, INDEX_NAME, oracle)
    expect(started.exited(), started.output()).toBe(false)
  }, 600_000)

  it('accepts batches of 1,536-dimension vectors until its heap nears the capped block', async () => {
    if (container === null) throw new Error('etcd never started')
    const started = await startNodeWithIndex(container.endpoint, {
      title: 'string',
      embedding: `vector[${VECTOR_DIMENSION}]`,
    })
    node = started

    let acknowledged = 0
    let refused = false
    let firstHeapUsed: number | null = null
    let batchDocuments = VECTOR_BATCH_DOCUMENTS
    let parseRefusals = 0
    for (let sent = 0; sent < VECTOR_SEND_BUDGET_DOCUMENTS && !refused; sent += batchDocuments) {
      const heapUsed = await heapUsedOf(started)
      firstHeapUsed ??= heapUsed
      const acknowledgedBefore = acknowledged
      const { reply, peakHeapUsed } = await sendBatchSamplingHeap(started, batchOfLamps(sent, batchDocuments))
      expect([200, 429], `the node stopped answering after ${acknowledged} documents`).toContain(reply.status)
      if (reply.status === 429) {
        const details = errorOf({ status: 429, body: reply.body }).details
        expect(details?.reason, JSON.stringify(reply.body)).toBe('parse_would_fill_memory')
        expect(
          Number(details?.heapBytes) +
            Number(details?.youngHeapBytes) +
            Number(details?.parseBytes) +
            Number(details?.reservedBytes),
          `the node refused a body that fitted under its block: ${JSON.stringify(details)}`,
        ).toBeGreaterThan(Number(details?.blockBytes))
        expect(batchDocuments, 'the node refused to parse a body of one vector document').toBeGreaterThan(1)
        parseRefusals++
        batchDocuments = Math.ceil(batchDocuments / 2)
        continue
      }
      const failed = reply.body.failed as BatchFailure[]
      for (const failure of failed) {
        expect(failure.error.code).toBe('CLUSTER_WRITE_BLOCKED')
        expect(failure.error.details?.reason).toBe('write_would_fill_memory')
      }
      acknowledged += (reply.body.succeeded as string[]).length
      refused = failed.length > 0
      if (!refused) continue
      const heapFraction = peakHeapUsed / started.heapLimitBytes
      const documentBytes = failed[0]?.error.details?.documentBytes
      const heapPerDocument = (heapUsed - firstHeapUsed) / acknowledgedBefore
      const boundOverHeap = Number(documentBytes) / heapPerDocument
      console.log(
        `vectors: first document refusal after ${acknowledged} documents and ${parseRefusals} parse refusals, ` +
          `in a batch of ${batchDocuments}, heap at ` +
          `${(heapUsed / started.heapLimitBytes).toFixed(3)} before it and ${heapFraction.toFixed(3)} at its peak, ` +
          `bound ${String(documentBytes)} bytes per document against ${heapPerDocument.toFixed(0)} bytes of heap ` +
          `spent per acknowledged document, a ratio of ${boundOverHeap.toFixed(1)}`,
      )
      expect(
        heapFraction,
        `refused a vector batch with the heap at ${heapFraction.toFixed(3)} of its limit`,
      ).toBeGreaterThan(CAPPED_HEAP_BLOCK_FRACTION - VECTOR_BATCH_HEAP_FRACTION)
      expect(typeof documentBytes, `the first refusal carried no document bound: ${JSON.stringify(reply.body)}`).toBe(
        'number',
      )
      expect(boundOverHeap, 'the vector bound over-charges the heap that a vector document takes').toBeLessThan(
        VECTOR_BOUND_OVER_HEAP_MAX_RATIO,
      )
    }

    expect(refused, `the node refused no vector document after ${VECTOR_SEND_BUDGET_DOCUMENTS} were sent`).toBe(true)
    const counted = await request(started.base, 'GET', `/indexes/${INDEX_NAME}/count`)
    expect(counted.body.count).toBe(acknowledged)
    expect(started.exited(), started.output()).toBe(false)
  }, 900_000)
})
