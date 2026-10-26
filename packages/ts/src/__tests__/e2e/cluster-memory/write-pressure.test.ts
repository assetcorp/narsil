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
import { errorOf, type NodeProcess, request, startNodeProcess, waitFor } from './harness'

const HEAP_MEGABYTES = 192
const INDEX_NAME = 'catalogue'
const CONCURRENT_BATCHES = 40
const BATCH_DOCUMENTS = 2_000
const WORDS_PER_BODY = 120
const VOCABULARY_WORDS = 20_000
const HEAP_SAMPLE_INTERVAL_MS = 50
const PROPAGATION_TIMEOUT_MS = 20_000
const CRASH_TIMEOUT_MS = 120_000
const UNBOUNDED_FRACTION = 1
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

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

const random = createRandom(79)

function inventedWord(): string {
  let word = 'zq'
  for (let letter = 0; letter < 6; letter++) {
    word += LETTERS[Math.floor(random() * LETTERS.length)]
  }
  return word
}

const VOCABULARY = Array.from({ length: VOCABULARY_WORDS }, inventedWord)

function furnitureNumber(serial: number): Furniture {
  const words: string[] = []
  for (let word = 0; word < WORDS_PER_BODY; word++) {
    words.push(VOCABULARY[Math.floor(random() * VOCABULARY.length)])
  }
  const kind = serial % 2 === 0 ? 'Oak chair' : 'Brass lamp'
  return { id: `item-${serial}`, title: `${kind} ${serial}`, body: words.join(' ') }
}

function titledChair(document: Furniture): boolean {
  return document.title.toLowerCase().split(' ').includes('chair')
}

interface BatchOutcome {
  status: number | null
  body: Record<string, unknown>
  documents: Furniture[]
}

async function sendBatch(base: string, documents: Furniture[], payload: string): Promise<BatchOutcome> {
  try {
    const response = await fetch(`${base}/indexes/${INDEX_NAME}/documents/_batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
    const text = await response.text()
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : {}
    const body = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    return { status: response.status, body, documents }
  } catch {
    return { status: null, body: {}, documents }
  }
}

async function fireConcurrentBatches(
  node: NodeProcess,
): Promise<{ outcomes: BatchOutcome[]; peakHeapBytes: number; sourceBytes: number }> {
  const batches: Array<{ documents: Furniture[]; payload: string }> = []
  let sourceBytes = 0
  for (let batch = 0; batch < CONCURRENT_BATCHES; batch++) {
    const documents: Furniture[] = []
    for (let count = 0; count < BATCH_DOCUMENTS; count++) {
      documents.push(furnitureNumber(batch * BATCH_DOCUMENTS + count))
    }
    const payload = JSON.stringify({ documents })
    sourceBytes += payload.length
    batches.push({ documents, payload })
  }

  let peakHeapBytes = 0
  let sampling = true
  const sampler = (async () => {
    while (sampling && !node.exited()) {
      try {
        const reply = await request(node.base, 'GET', '/stats/memory')
        const figures = reply.body.process as { heapUsed?: unknown } | null
        if (typeof figures?.heapUsed === 'number') peakHeapBytes = Math.max(peakHeapBytes, figures.heapUsed)
      } catch {
        return
      }
      await sleep(HEAP_SAMPLE_INTERVAL_MS)
    }
  })()

  const outcomes = await Promise.all(batches.map(({ documents, payload }) => sendBatch(node.base, documents, payload)))
  sampling = false
  await sampler
  return { outcomes, peakHeapBytes, sourceBytes }
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

describe('a cluster node on etcd bounds the bytes of inserts and updates in flight', () => {
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

  async function startSingleNode(inFlightWriteFraction?: number): Promise<NodeProcess> {
    if (container === null) throw new Error('etcd never started')
    const started = await startNodeProcess({
      nodeId: 'node-1',
      etcdEndpoint: container.endpoint,
      keyPrefix: `_narsil_write_pressure_${randomUUID()}`,
      heapMegabytes: HEAP_MEGABYTES,
      inFlightWriteFraction,
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

  it('refuses the excess of a burst with 429 and keeps every write it accepted', async () => {
    const bounded = await startSingleNode()
    const { outcomes, peakHeapBytes, sourceBytes } = await fireConcurrentBatches(bounded)

    expect(bounded.exited(), bounded.output()).toBe(false)
    const oracle = new Map<string, Furniture>()
    let refused = 0
    for (const outcome of outcomes) {
      expect([200, 429], JSON.stringify(outcome.body).slice(0, 500)).toContain(outcome.status)
      if (outcome.status === 429) {
        refused++
        expect(errorOf({ status: 429, body: outcome.body }).code).toBe('CLUSTER_WRITE_BLOCKED')
        expect(errorOf({ status: 429, body: outcome.body }).details).toMatchObject({
          reason: 'write_bytes_in_flight',
          indexName: INDEX_NAME,
          nodeId: 'node-1',
        })
        continue
      }
      expect(outcome.body.failed).toEqual([])
      for (const document of outcome.documents) oracle.set(document.id, document)
    }
    console.log(
      `bounded node: ${outcomes.length - refused} of ${outcomes.length} batches accepted, ${refused} refused, ` +
        `${megabytes(sourceBytes)} sent, heap peaked at ${megabytes(peakHeapBytes)} of ${megabytes(bounded.heapLimitBytes)}`,
    )
    expect(refused).toBeGreaterThan(0)
    expect(oracle.size).toBeGreaterThan(0)
    expect(peakHeapBytes).toBeLessThan(bounded.heapLimitBytes)

    const counted = await request(bounded.base, 'GET', `/indexes/${INDEX_NAME}/count`)
    expect(counted.body.count).toBe(oracle.size)
    const chairs = await request(bounded.base, 'POST', `/indexes/${INDEX_NAME}/search`, {
      term: 'chair',
      fields: ['title'],
      tolerance: 0,
      limit: 5,
    })
    expect(chairs.body.count).toBe([...oracle.values()].filter(titledChair).length)

    const late = furnitureNumber(CONCURRENT_BATCHES * BATCH_DOCUMENTS)
    const accepted = await request(bounded.base, 'POST', `/indexes/${INDEX_NAME}/documents/_batch`, {
      documents: [late],
    })
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    expect(bounded.exited(), bounded.output()).toBe(false)
  }, 300_000)

  it('runs out of heap under the same burst when the bound covers the whole heap', async () => {
    const unbounded = await startSingleNode(UNBOUNDED_FRACTION)
    const { outcomes, sourceBytes } = await fireConcurrentBatches(unbounded)
    await waitFor('the unbounded node to run out of heap', CRASH_TIMEOUT_MS, async () => unbounded.exited())
    const answered = outcomes.filter(outcome => outcome.status !== null).length
    console.log(
      `unbounded node: exited after answering ${answered} of ${outcomes.length} batches, ${megabytes(sourceBytes)} sent`,
    )
    expect(unbounded.output()).toMatch(/heap out of memory/i)
  }, 300_000)
})
