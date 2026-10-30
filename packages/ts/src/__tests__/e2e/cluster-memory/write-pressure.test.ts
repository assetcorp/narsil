import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ClusterMemoryConfig } from '../../../distribution/cluster-node/types'
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
const CONCURRENT_BATCHES = 40
const BATCH_DOCUMENTS = 2_000
const WORDS_PER_BODY = 120
const VOCABULARY_WORDS = 20_000
const HEAP_SAMPLE_INTERVAL_MS = 50
const PROPAGATION_TIMEOUT_MS = 20_000
const SEND_BUDGET_HEAP_LIMITS = 3
const CAPPED_HEAP_BLOCK_FRACTION = 0.75
const V8_INEFFECTIVE_MARK_COMPACT_FRACTION = 0.8
const BATCH_REPLY_TIMEOUT_MS = 60_000
const MAX_BURSTS = 60
const BURSTS_DEADLINE_MS = 150_000
const PARSE_WOULD_FILL_MEMORY_REASON = 'parse_would_fill_memory'
const MEMORY_BLOCK_SWITCHED_OFF: ClusterMemoryConfig = { blockWritesAbove: 1, resumeWritesBelow: 0.99 }
const IN_FLIGHT_BOUND_SWITCHED_OFF: ClusterMemoryConfig = { ...MEMORY_BLOCK_SWITCHED_OFF, inFlightWriteFraction: 1 }
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const BATCH_REFUSAL_REASONS = ['write_bytes_in_flight', 'node_memory_full']
const MEMORY_REFUSAL_REASONS = ['node_memory_full', 'write_would_fill_memory']

interface Furniture {
  id: string
  title: string
  body: string
}

interface BatchFailure {
  docId: string
  error: { code: string; details?: Record<string, unknown> }
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
  payloadBytes: number
}

async function sendBatch(base: string, documents: Furniture[], payload: string): Promise<BatchOutcome> {
  try {
    const response = await fetch(`${base}/indexes/${INDEX_NAME}/documents/_batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(BATCH_REPLY_TIMEOUT_MS),
    })
    const text = await response.text()
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : {}
    const body = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    return { status: response.status, body, documents, payloadBytes: payload.length }
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null
    const failure = { fetchError: String(error), cause: cause === null ? null : `${cause.name}: ${cause.message}` }
    return { status: null, body: failure, documents, payloadBytes: payload.length }
  }
}

async function fireConcurrentBatches(
  node: NodeProcess,
  firstSerial = 0,
): Promise<{ outcomes: BatchOutcome[]; peakHeapBytes: number; sourceBytes: number }> {
  const batches: Array<{ documents: Furniture[]; payload: string }> = []
  let sourceBytes = 0
  for (let batch = 0; batch < CONCURRENT_BATCHES; batch++) {
    const documents: Furniture[] = []
    for (let count = 0; count < BATCH_DOCUMENTS; count++) {
      documents.push(furnitureNumber(firstSerial + batch * BATCH_DOCUMENTS + count))
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

function heapWithinParseOfBlock(details: Record<string, unknown>): boolean {
  const heldBytes = Number(details.heapBytes) + Number(details.youngHeapBytes)
  return heldBytes + Number(details.parseBytes) > Number(details.blockBytes)
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

  async function startSingleNode(memory?: ClusterMemoryConfig): Promise<NodeProcess> {
    if (container === null) throw new Error('etcd never started')
    const started = await startNodeProcess({
      nodeId: 'node-1',
      etcdEndpoint: container.endpoint,
      keyPrefix: `_narsil_write_pressure_${randomUUID()}`,
      heapMegabytes: HEAP_MEGABYTES,
      memory,
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
    let refusedDocuments = 0
    for (const outcome of outcomes) {
      expect([200, 429], JSON.stringify(outcome.body).slice(0, 500)).toContain(outcome.status)
      if (outcome.status === 429) {
        refused++
        if (isServerMemoryRefusal({ status: 429, body: outcome.body })) continue
        const refusal = errorOf({ status: 429, body: outcome.body })
        expect(refusal.code, JSON.stringify(refusal)).toBe('CLUSTER_WRITE_BLOCKED')
        expect(refusal.details).toMatchObject({ indexName: INDEX_NAME })
        expect(BATCH_REFUSAL_REASONS).toContain(refusal.details.reason)
        if (refusal.details.reason === 'node_memory_full') {
          expect(refusal.details.fullNodeIds).toEqual(['node-1'])
        } else {
          expect(refusal.details.nodeId).toBe('node-1')
        }
        continue
      }
      const failed = outcome.body.failed as BatchFailure[]
      for (const failure of failed) {
        expect(failure.error.code).toBe('CLUSTER_WRITE_BLOCKED')
        expect(failure.error.details?.reason).toBe('write_would_fill_memory')
      }
      refusedDocuments += failed.length
      const byId = new Map(outcome.documents.map(document => [document.id, document]))
      for (const docId of outcome.body.succeeded as string[]) {
        const document = byId.get(docId)
        if (document === undefined) throw new Error(`the node acknowledged ${docId}, which the batch never held`)
        oracle.set(docId, document)
      }
    }
    const peakOldGenerationBytes = await bounded.peakOldGenerationBytes()
    console.log(
      `bounded node: ${outcomes.length - refused} of ${outcomes.length} batches answered 200, ${refused} refused, ` +
        `${refusedDocuments} documents refused inside accepted batches, ${oracle.size} documents kept, ` +
        `${megabytes(sourceBytes)} sent, heapUsed peaked at ${megabytes(peakHeapBytes)} and the old generation at ` +
        `${megabytes(peakOldGenerationBytes)}, against an old-space limit of ${megabytes(bounded.heapLimitBytes)}`,
    )
    expect(refused).toBeGreaterThan(0)
    expect(oracle.size).toBeGreaterThan(0)
    expect(peakOldGenerationBytes).toBeLessThan(bounded.heapLimitBytes)

    const counted = await request(bounded.base, 'GET', `/indexes/${INDEX_NAME}/count`)
    expect(counted.body.count).toBe(oracle.size)
    const chairs = await request(bounded.base, 'POST', `/indexes/${INDEX_NAME}/search`, {
      term: 'chair',
      fields: ['title'],
      tolerance: 0,
      limit: 5,
    })
    expect(chairs.body.count).toBe([...oracle.values()].filter(titledChair).length)
    await expectEveryDocumentReadsBack(bounded.base, INDEX_NAME, oracle)

    const late = furnitureNumber(CONCURRENT_BATCHES * BATCH_DOCUMENTS)
    const lateReply = await request(bounded.base, 'POST', `/indexes/${INDEX_NAME}/documents/_batch`, {
      documents: [late],
    })
    expect([200, 429]).toContain(lateReply.status)
    const lateReasons =
      lateReply.status === 429
        ? [errorOf(lateReply).details.reason]
        : (lateReply.body.failed as BatchFailure[]).map(failure => failure.error.details?.reason)
    for (const reason of lateReasons) expect(MEMORY_REFUSAL_REASONS).toContain(reason)
    expect(bounded.exited(), bounded.output()).toBe(false)
  }, 300_000)

  it('refuses at the capped heap block under the same burst once the in-flight bound covers the whole heap', async () => {
    const unbounded = await startSingleNode(IN_FLIGHT_BOUND_SWITCHED_OFF)
    const sendBudgetBytes = unbounded.heapLimitBytes * SEND_BUDGET_HEAP_LIMITS
    const replies = new Map<string, number>()
    const oracle = new Map<string, Furniture>()
    let projectionRefusals = 0
    const projectionDetails: Array<Record<string, unknown>> = []
    let fullRefusals = 0
    let sentBytes = 0
    let admittedBytes = 0
    const blockParseDetails: Array<Record<string, unknown>> = []
    let lastParseDetails: Record<string, unknown> | null = null
    let bursts = 0
    const burstsStartedAt = performance.now()
    while (
      projectionRefusals === 0 &&
      fullRefusals === 0 &&
      blockParseDetails.length === 0 &&
      admittedBytes < sendBudgetBytes &&
      bursts < MAX_BURSTS &&
      performance.now() - burstsStartedAt < BURSTS_DEADLINE_MS
    ) {
      const { outcomes, sourceBytes } = await fireConcurrentBatches(
        unbounded,
        bursts * CONCURRENT_BATCHES * BATCH_DOCUMENTS,
      )
      bursts++
      sentBytes += sourceBytes
      for (const outcome of outcomes) {
        const key = String(outcome.status ?? 'no reply')
        replies.set(key, (replies.get(key) ?? 0) + 1)
        expect([200, 429], JSON.stringify(outcome.body).slice(0, 500)).toContain(outcome.status)
        if (outcome.status === 429) {
          if (isServerMemoryRefusal({ status: 429, body: outcome.body })) {
            const { details } = errorOf({ status: 429, body: outcome.body })
            if (details.reason !== PARSE_WOULD_FILL_MEMORY_REASON) continue
            lastParseDetails = details
            if (heapWithinParseOfBlock(details)) blockParseDetails.push(details)
            continue
          }
          admittedBytes += outcome.payloadBytes
          const refusal = errorOf({ status: 429, body: outcome.body })
          expect(refusal.code, JSON.stringify(refusal)).toBe('CLUSTER_WRITE_BLOCKED')
          expect(refusal.details.reason).toBe('node_memory_full')
          fullRefusals++
          continue
        }
        admittedBytes += outcome.payloadBytes
        const failed = outcome.body.failed as BatchFailure[]
        for (const failure of failed) {
          expect(failure.error.code).toBe('CLUSTER_WRITE_BLOCKED')
          expect(failure.error.details?.reason).toBe('write_would_fill_memory')
        }
        projectionRefusals += failed.length
        const failedIds = new Set(failed.map(failure => failure.docId))
        for (const failure of failed) {
          const details = failure.error.details ?? {}
          if (details.refusedDocId === undefined) projectionDetails.push(details)
          else expect(failedIds, JSON.stringify(details)).toContain(details.refusedDocId)
        }
        const byId = new Map(outcome.documents.map(document => [document.id, document]))
        for (const docId of outcome.body.succeeded as string[]) {
          const document = byId.get(docId)
          if (document === undefined) throw new Error(`the node acknowledged ${docId}, which the batch never held`)
          oracle.set(docId, document)
        }
      }
      expect(unbounded.exited(), unbounded.output()).toBe(false)
    }
    const peakOldGenerationBytes = await unbounded.peakOldGenerationBytes()
    const peakFraction = peakOldGenerationBytes / unbounded.heapLimitBytes
    const tally = [...replies].map(([status, count]) => `${count} × ${status}`).join(', ')
    console.log(
      `unbounded node: ${tally} over ${bursts} bursts, ${megabytes(sentBytes)} sent and ${megabytes(admittedBytes)} ` +
        `read past the server's body budget, ${projectionRefusals} ` +
        `documents refused with write_would_fill_memory, ${fullRefusals} batches with node_memory_full, ` +
        `${blockParseDetails.length} batches with parse_would_fill_memory within one parse of the block, the old ` +
        `generation peaked at ${peakFraction.toFixed(3)} of its limit`,
    )
    expect(
      projectionRefusals + fullRefusals + blockParseDetails.length,
      `the node never reached its block after ${bursts} bursts in ${Math.round(performance.now() - burstsStartedAt)} ms ` +
        `and ${megabytes(admittedBytes)} of documents taken in; replies ${tally}; last parse refusal ` +
        JSON.stringify(lastParseDetails),
    ).toBeGreaterThan(0)
    const cappedBlockBytes = Math.floor(CAPPED_HEAP_BLOCK_FRACTION * unbounded.heapLimitBytes)
    for (const details of blockParseDetails) {
      expect(details.blockBytes, JSON.stringify(details)).toBe(cappedBlockBytes)
    }
    if (projectionRefusals > 0) expect(projectionDetails.length).toBeGreaterThan(0)
    for (const details of projectionDetails) {
      expect(details.blockBytes, JSON.stringify(details)).toBe(cappedBlockBytes)
      const committedBytes =
        Number(details.heapBytes) +
        Number(details.youngHeapBytes) +
        Number(details.projectedBytes) +
        Number(details.documentBytes)
      expect(committedBytes, JSON.stringify(details)).toBeGreaterThan(cappedBlockBytes)
    }
    expect(peakFraction).toBeLessThan(V8_INEFFECTIVE_MARK_COMPACT_FRACTION)
    await expectEveryDocumentReadsBack(unbounded.base, INDEX_NAME, oracle)
    expect(unbounded.exited(), unbounded.output()).toBe(false)
  }, 300_000)
})
