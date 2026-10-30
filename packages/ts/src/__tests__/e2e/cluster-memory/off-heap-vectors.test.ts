import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type EtcdContainerHandle,
  MANAGED_ETCD_ENDPOINT,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from '../../distribution/coordinator/etcd-integration/fixtures'
import { type ContainerNode, startContainerNode, writeMeminfo } from './container-node'
import { errorOf, expectEveryDocumentReadsBack, isServerMemoryRefusal, request, waitFor } from './harness'

const MEGABYTE_BYTES = 1024 * 1024
const HEAP_MEGABYTES = 192
const CONTAINER_MEMORY_MEGABYTES = 384
const HOST_TOTAL_BYTES = 8 * 1024 * MEGABYTE_BYTES
const NODE_SHARE_BYTES = 384 * MEGABYTE_BYTES
const INDEX_NAME = 'lamps'
const DIMENSION = 1_536
const BATCH_DOCUMENTS = 250
const SEND_BUDGET_DOCUMENTS = 40_000
const BATCHES_AFTER_REFUSAL = 20
const PROBE_EVERY_DOCUMENTS = 2_000
const READ_BACK_DOCUMENTS = 100
const MAX_HEAP_FRACTION_AT_REFUSAL = 0.5
const MIN_RESIDENT_FRACTION_AT_REFUSAL = 0.75
const MIN_SPENT_FRACTION_OF_SHARE_AT_REFUSAL = 0.5
const PROPAGATION_TIMEOUT_MS = 30_000

interface Lamp {
  id: string
  title: string
  embedding: number[]
}

interface FeedOutcome {
  kept: Map<string, { title: string }>
  probes: Map<string, number[]>
  firstRefusal: Record<string, unknown> | null
  heapUsedAtRefusal: number | null
  residentAtRefusal: number | null
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

function lampsFrom(first: number, count: number, random: () => number): Lamp[] {
  return Array.from({ length: count }, (_, offset) => ({
    id: `lamp-${first + offset}`,
    title: `Brass lamp ${first + offset}`,
    embedding: Array.from({ length: DIMENSION }, () => random() * 2 - 1),
  }))
}

async function processFigures(node: ContainerNode): Promise<{ heapUsed: number; rss: number }> {
  const reply = await request(node.base, 'GET', '/stats/memory')
  const figures = reply.body.process as { heapUsed?: unknown; rss?: unknown } | null
  if (typeof figures?.heapUsed !== 'number' || typeof figures.rss !== 'number') {
    throw new Error(`the node reported no process figures: ${JSON.stringify(reply.body)}`)
  }
  return { heapUsed: figures.heapUsed, rss: figures.rss }
}

async function createLampIndex(node: ContainerNode): Promise<void> {
  const created = await request(node.base, 'POST', '/indexes', {
    name: INDEX_NAME,
    config: { schema: { title: 'string', embedding: `vector[${DIMENSION}]` } },
  })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  await waitFor(`${INDEX_NAME} to have an active primary`, PROPAGATION_TIMEOUT_MS, async () => {
    const reply = await request(node.base, 'GET', `/indexes/${INDEX_NAME}/cluster`)
    const partitions = (reply.body.partitions ?? []) as Array<{ primary: string | null; state: string }>
    return partitions.some(partition => partition.state === 'ACTIVE' && partition.primary !== null)
  })
}

async function recordRefusal(
  node: ContainerNode,
  outcome: FeedOutcome,
  details: Record<string, unknown>,
): Promise<void> {
  if (outcome.firstRefusal !== null) return
  const figures = await processFigures(node)
  outcome.firstRefusal = details
  outcome.heapUsedAtRefusal = figures.heapUsed
  outcome.residentAtRefusal = figures.rss
}

async function feedUntilRefused(node: ContainerNode): Promise<FeedOutcome> {
  const random = createRandom(12)
  const outcome: FeedOutcome = {
    kept: new Map(),
    probes: new Map(),
    firstRefusal: null,
    heapUsedAtRefusal: null,
    residentAtRefusal: null,
  }
  let batchesAfterRefusal = 0
  for (let sent = 0; sent < SEND_BUDGET_DOCUMENTS && batchesAfterRefusal < BATCHES_AFTER_REFUSAL; ) {
    const lamps = lampsFrom(sent, BATCH_DOCUMENTS, random)
    sent += BATCH_DOCUMENTS
    if (outcome.firstRefusal !== null) batchesAfterRefusal++
    const reply = await request(node.base, 'POST', `/indexes/${INDEX_NAME}/documents/_batch`, { documents: lamps })
    if (reply.status === 429) {
      if (!isServerMemoryRefusal(reply)) {
        expect(errorOf(reply).code, JSON.stringify(reply.body).slice(0, 500)).toBe('CLUSTER_WRITE_BLOCKED')
      }
      await recordRefusal(node, outcome, errorOf(reply).details)
      continue
    }
    expect(reply.status, JSON.stringify(reply.body).slice(0, 500)).toBe(200)
    const failed = reply.body.failed as Array<{ error: { code: string; details?: Record<string, unknown> } }>
    for (const failure of failed) expect(failure.error.code).toBe('CLUSTER_WRITE_BLOCKED')
    const byId = new Map(lamps.map(lamp => [lamp.id, lamp]))
    for (const docId of reply.body.succeeded as string[]) {
      const lamp = byId.get(docId)
      if (lamp === undefined) throw new Error(`the node acknowledged ${docId}, which the batch never held`)
      outcome.kept.set(docId, { title: lamp.title })
      if (Number(docId.slice('lamp-'.length)) % PROBE_EVERY_DOCUMENTS === 0) outcome.probes.set(docId, lamp.embedding)
    }
    if (failed.length > 0) await recordRefusal(node, outcome, failed[0].error.details ?? {})
  }
  return outcome
}

async function expectKeptLampsServed(node: ContainerNode, outcome: FeedOutcome): Promise<void> {
  const counted = await request(node.base, 'GET', `/indexes/${INDEX_NAME}/count`)
  expect(counted.body.count).toBe(outcome.kept.size)
  await expectEveryDocumentReadsBack(node.base, INDEX_NAME, outcome.kept, READ_BACK_DOCUMENTS)
  expect(outcome.probes.size).toBeGreaterThan(0)
  for (const [docId, embedding] of outcome.probes) {
    const reply = await request(node.base, 'POST', `/indexes/${INDEX_NAME}/search`, {
      vector: { field: 'embedding', value: embedding },
      limit: 1,
    })
    expect(reply.status, JSON.stringify(reply.body).slice(0, 500)).toBe(200)
    const hits = reply.body.hits as Array<{ id: string }>
    expect(hits[0]?.id, `the nearest lamp to ${docId}'s own vector`).toBe(docId)
  }
}

describe('a cluster node whose vectors fill memory outside its heap', () => {
  let etcd: EtcdContainerHandle | null = null
  let node: ContainerNode | null = null
  let workDirectory: string | null = null

  beforeAll(async () => {
    await runDocker(['version'])
    if (MANAGED_ETCD_ENDPOINT !== null) {
      etcd = { endpoint: MANAGED_ETCD_ENDPOINT, name: null }
      await waitForEtcdReady(MANAGED_ETCD_ENDPOINT)
    } else {
      etcd = await startEtcdContainer()
    }
  }, 180_000)

  afterEach(async () => {
    await node?.stop()
    node = null
    if (workDirectory !== null) await rm(workDirectory, { recursive: true, force: true })
    workDirectory = null
  }, 60_000)

  afterAll(async () => {
    await stopEtcdContainer(etcd?.name ?? null)
  }, 60_000)

  it('refuses vector writes inside a container before the container limit kills it', async () => {
    if (etcd === null) throw new Error('etcd never started')
    const containerBytes = CONTAINER_MEMORY_MEGABYTES * MEGABYTE_BYTES
    node = await startContainerNode({
      nodeId: 'node-1',
      etcdEndpoint: etcd.endpoint,
      keyPrefix: `_narsil_off_heap_${randomUUID()}`,
      heapMegabytes: HEAP_MEGABYTES,
      memoryMegabytes: CONTAINER_MEMORY_MEGABYTES,
    })
    await createLampIndex(node)

    const outcome = await feedUntilRefused(node)
    console.log(
      `container: ${outcome.kept.size} lamps kept, resident ${outcome.residentAtRefusal} and heap ${outcome.heapUsedAtRefusal} bytes at the first refusal ${JSON.stringify(outcome.firstRefusal)}`,
    )
    expect(outcome.firstRefusal, `the node refused nothing after ${SEND_BUDGET_DOCUMENTS} lamps`).not.toBeNull()
    expect(node.exited(), node.output().slice(-3_000)).toBe(false)
    expect(await node.oomKilled()).toBe(false)
    expect(Number(outcome.heapUsedAtRefusal)).toBeLessThan(MAX_HEAP_FRACTION_AT_REFUSAL * node.heapLimitBytes)
    expect(Number(outcome.residentAtRefusal)).toBeGreaterThan(MIN_RESIDENT_FRACTION_AT_REFUSAL * containerBytes)
    await expectKeptLampsServed(node, outcome)
  }, 300_000)

  it('refuses vector writes on a Linux host without a container limit before available memory runs out', async () => {
    if (etcd === null) throw new Error('etcd never started')
    workDirectory = await mkdtemp(join(tmpdir(), 'narsil-meminfo-'))
    const meminfoPath = join(workDirectory, 'meminfo')
    await writeMeminfo(meminfoPath, HOST_TOTAL_BYTES, NODE_SHARE_BYTES)
    node = await startContainerNode({
      nodeId: 'node-1',
      etcdEndpoint: etcd.endpoint,
      keyPrefix: `_narsil_off_heap_${randomUUID()}`,
      heapMegabytes: HEAP_MEGABYTES,
      meminfoPath,
      hostShareBytes: NODE_SHARE_BYTES,
    })
    const started = node
    await createLampIndex(started)
    const outcome = await feedUntilRefused(started)
    const highestResident = await started.peakResidentBytes()
    console.log(
      `host: ${outcome.kept.size} lamps kept, highest resident ${highestResident} of a ${NODE_SHARE_BYTES}-byte share, resident ${outcome.residentAtRefusal} at the first refusal ${JSON.stringify(outcome.firstRefusal)}`,
    )
    expect(outcome.firstRefusal, `the node refused nothing after ${SEND_BUDGET_DOCUMENTS} lamps`).not.toBeNull()
    expect(highestResident, 'the node took more memory than the host had available').toBeLessThan(NODE_SHARE_BYTES)
    expect(Number(outcome.residentAtRefusal)).toBeGreaterThan(MIN_SPENT_FRACTION_OF_SHARE_AT_REFUSAL * NODE_SHARE_BYTES)
    expect(started.exited(), started.output().slice(-3_000)).toBe(false)
    await expectKeptLampsServed(started, outcome)
  }, 300_000)
})
