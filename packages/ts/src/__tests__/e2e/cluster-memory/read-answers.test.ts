import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
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
import { type ContainerNode, startContainerNode } from './container-node'
import { errorOf, isServerMemoryRefusal, request, waitFor } from './harness'

const HEAP_MEGABYTES = 192
const CONTAINER_MEMORY_MEGABYTES = 384
const INDEX_NAME = 'lamps'
const DIMENSION = 1_536
const BATCH_DOCUMENTS = 250
const SEND_BUDGET_DOCUMENTS = 40_000
const READ_DOCUMENTS = 1_000
const READ_ROUNDS = 3
const REQUEST_TIMEOUT_MS = 120_000
const PROPAGATION_TIMEOUT_MS = 30_000
const MEMORY_REFUSAL_REASONS = ['response_would_fill_memory', 'parse_would_fill_memory', 'request_bytes_in_flight']
const NOTES_INDEX = 'notes'
const SMALL_NOTES = 64
const LARGE_NOTE_CHARACTERS = 4 * 1024 * 1024
const BALLAST_HEAP_FRACTION = 0.89
const BALLAST_HOLD_BEFORE_READ_MS = 1_000
const CUT_LOG_TIMEOUT_MS = 5_000
const RECOVERY_TIMEOUT_MS = 30_000

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

function embeddingOf(lamp: number): number[] {
  const random = createRandom(lamp + 1)
  return Array.from({ length: DIMENSION }, () => random() * 2 - 1)
}

function titleOf(lamp: number): string {
  return `Brass lamp ${lamp}`
}

function lampNumberOf(docId: string): number {
  const lamp = Number(docId.slice('lamp-'.length))
  if (!docId.startsWith('lamp-') || !Number.isInteger(lamp)) throw new Error(`the node returned ${docId}`)
  return lamp
}

function expectLamp(docId: string, document: unknown, kept: ReadonlySet<string>): void {
  expect(kept.has(docId), `${docId} came back although the node never acknowledged it`).toBe(true)
  const lamp = lampNumberOf(docId)
  const { title, embedding } = document as { title?: unknown; embedding?: unknown }
  expect(title).toBe(titleOf(lamp))
  expect(Array.isArray(embedding) && embedding.length === DIMENSION, `${docId} holds its whole vector`).toBe(true)
  const expected = embeddingOf(lamp)
  const stored = embedding as number[]
  for (let at = 0; at < DIMENSION; at++) {
    if (stored[at] !== Math.fround(expected[at])) {
      throw new Error(`${docId} differs at dimension ${at}: ${stored[at]} against ${Math.fround(expected[at])}`)
    }
  }
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

async function feedUntilRefused(node: ContainerNode): Promise<Set<string>> {
  const kept = new Set<string>()
  for (let sent = 0; sent < SEND_BUDGET_DOCUMENTS; sent += BATCH_DOCUMENTS) {
    const lamps = Array.from({ length: BATCH_DOCUMENTS }, (_, offset) => ({
      id: `lamp-${sent + offset}`,
      title: titleOf(sent + offset),
      embedding: embeddingOf(sent + offset),
    }))
    const reply = await request(node.base, 'POST', `/indexes/${INDEX_NAME}/documents/_batch`, { documents: lamps })
    if (reply.status === 429) {
      if (!isServerMemoryRefusal(reply)) expect(errorOf(reply).code).toBe('CLUSTER_WRITE_BLOCKED')
      return kept
    }
    expect(reply.status, JSON.stringify(reply.body).slice(0, 500)).toBe(200)
    for (const docId of reply.body.succeeded as string[]) kept.add(docId)
    if ((reply.body.failed as unknown[]).length > 0) return kept
  }
  throw new Error(`the node refused nothing after ${SEND_BUDGET_DOCUMENTS} lamps`)
}

async function holdBallast(node: ContainerNode, action: string): Promise<void> {
  const response = await fetch(`${node.base}/indexes`, { headers: { 'x-narsil-test-ballast': action } })
  expect(response.status, await response.text()).toBe(409)
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

function readsFor(client: NarsilClient, kept: Set<string>, round: number): Array<() => Promise<void>> {
  const docIds = [...kept]
  const first = (round * READ_DOCUMENTS) % Math.max(1, docIds.length - READ_DOCUMENTS)
  const slice = docIds.slice(first, first + READ_DOCUMENTS)
  const probe = slice[0] ?? 'lamp-0'
  return [
    async () => {
      const found = await client.getMultiple(INDEX_NAME, slice)
      expect(found.size).toBe(slice.length)
      for (const docId of slice) expectLamp(docId, found.get(docId), kept)
    },
    async () => {
      const result = await client.query(INDEX_NAME, {
        vector: { field: 'embedding', value: embeddingOf(lampNumberOf(probe)) },
        limit: READ_DOCUMENTS,
      })
      expect(result.hits[0]?.id, `the nearest lamp to ${probe}'s own vector`).toBe(probe)
      expect(result.hits.length).toBe(Math.min(READ_DOCUMENTS, kept.size))
      for (const hit of result.hits) expectLamp(hit.id, hit.document, kept)
    },
    async () => {
      const page = await client.listDocuments(INDEX_NAME, { limit: READ_DOCUMENTS })
      expect(page.total).toBe(kept.size)
      expect(page.documents.length).toBe(Math.min(READ_DOCUMENTS, kept.size))
      for (const listed of page.documents) expectLamp(listed.id, listed.document, kept)
    },
  ]
}

describe('a cluster node in a container that answers reads larger than its free memory', () => {
  let etcd: EtcdContainerHandle | null = null
  let node: ContainerNode | null = null

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
  }, 60_000)

  afterAll(async () => {
    await stopEtcdContainer(etcd?.name ?? null)
  }, 60_000)

  it('answers or refuses with a typed error every 1,000-document read and stays up', async () => {
    if (etcd === null) throw new Error('etcd never started')
    node = await startContainerNode({
      nodeId: 'node-1',
      etcdEndpoint: etcd.endpoint,
      keyPrefix: `_narsil_read_answers_${randomUUID()}`,
      heapMegabytes: HEAP_MEGABYTES,
      memoryMegabytes: CONTAINER_MEMORY_MEGABYTES,
    })
    await createLampIndex(node)
    const kept = await feedUntilRefused(node)
    expect(kept.size).toBeGreaterThan(READ_DOCUMENTS)

    const client = createNarsilClient({ url: node.base, timeoutMs: REQUEST_TIMEOUT_MS })
    const outcomes: ReadOutcomes = { answered: 0, refused: [], cut: 0 }
    for (let round = 0; round < READ_ROUNDS; round++) {
      await Promise.all(readsFor(client, kept, round).map(read => settle(read, outcomes)))
    }
    const started = node
    expect(started.exited(), started.output().slice(-3_000)).toBe(false)
    expect(await started.oomKilled()).toBe(false)
    const highestResident = await started.peakResidentBytes()
    console.log(
      `reads: ${kept.size} lamps kept, ${outcomes.answered} answered, ${outcomes.refused.length} refused, ${outcomes.cut} cut, highest resident ${highestResident} bytes ${JSON.stringify(outcomes.refused[0] ?? null)}`,
    )
    expect(started.exited(), started.output().slice(-3_000)).toBe(false)
    expect(await started.oomKilled()).toBe(false)
    expect(outcomes.answered).toBeGreaterThan(0)
    await settle(readsFor(client, kept, 0)[0], outcomes)
    expect(started.exited(), started.output().slice(-3_000)).toBe(false)
  }, 300_000)

  it('closes the connection of an answer that waits too long for memory, and the client raises a typed error', async () => {
    if (etcd === null) throw new Error('etcd never started')
    node = await startContainerNode({
      nodeId: 'node-1',
      etcdEndpoint: etcd.endpoint,
      keyPrefix: `_narsil_read_answers_${randomUUID()}`,
      heapMegabytes: HEAP_MEGABYTES,
      memoryMegabytes: CONTAINER_MEMORY_MEGABYTES,
    })
    const started = node
    const created = await request(started.base, 'POST', '/indexes', {
      name: NOTES_INDEX,
      config: { schema: { title: 'string' } },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const notes = Array.from({ length: SMALL_NOTES }, (_, serial) => ({
      id: `note-${serial}`,
      title: `Note ${serial}`,
    }))
    const largeNote = { id: 'note-large', title: 'Large note', attachment: 'x'.repeat(LARGE_NOTE_CHARACTERS) }
    await waitFor(`${NOTES_INDEX} to accept writes`, PROPAGATION_TIMEOUT_MS, async () => {
      const reply = await request(started.base, 'POST', `/indexes/${NOTES_INDEX}/documents/_batch`, {
        documents: notes,
      })
      return reply.status === 200
    })
    const inserted = await request(started.base, 'POST', `/indexes/${NOTES_INDEX}/documents/_batch`, {
      documents: [largeNote],
    })
    expect(inserted.status, JSON.stringify(inserted.body).slice(0, 500)).toBe(200)
    expect(inserted.body.succeeded).toEqual([largeNote.id])
    const docIds = [...notes.map(note => note.id), largeNote.id]

    await holdBallast(started, String(BALLAST_HEAP_FRACTION))
    await sleep(BALLAST_HOLD_BEFORE_READ_MS)
    const client = createNarsilClient({ url: started.base, timeoutMs: REQUEST_TIMEOUT_MS })
    const outcome = await client.getMultiple(NOTES_INDEX, docIds).then(
      found => found.size,
      (err: unknown) => err,
    )
    expect(isNarsilError(outcome), `the read ended with ${String(outcome)}`).toBe(true)
    if (!isNarsilError(outcome)) return
    expect(outcome.code, outcome.message).toBe('CLIENT_CONNECTION_FAILED')
    await waitFor('the node to log the cut answer', CUT_LOG_TIMEOUT_MS, async () =>
      started.output().includes('closed the connection part way through its answer'),
    )

    await holdBallast(started, 'release')
    const outcomes: ReadOutcomes = { answered: 0, refused: [], cut: 0 }
    const deadline = Date.now() + RECOVERY_TIMEOUT_MS
    while (outcomes.answered === 0 && Date.now() < deadline) {
      await settle(async () => {
        const found = await client.getMultiple(NOTES_INDEX, docIds)
        expect(found.size).toBe(docIds.length)
        for (const note of notes) expect(found.get(note.id)).toEqual(note)
        expect(found.get(largeNote.id)).toEqual(largeNote)
      }, outcomes)
    }
    expect(outcomes.answered, JSON.stringify(outcomes)).toBe(1)
    expect(started.exited(), started.output().slice(-3_000)).toBe(false)
    expect(await started.oomKilled()).toBe(false)
  }, 300_000)
})
