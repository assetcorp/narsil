import { randomUUID } from 'node:crypto'
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
import { errorOf, type NodeProcess, request, startNodeProcess, waitFor } from './harness'

const HEAP_MEGABYTES = 192
const HEAP_LIMIT_BYTES = HEAP_MEGABYTES * 1_048_576
const HEAP_BLOCK_FRACTION = 0.7
const MEMORY: ClusterMemoryConfig = { blockWritesAbove: HEAP_BLOCK_FRACTION, resumeWritesBelow: 0.6 }
const ROOM_LEFT_BYTES = 6 * 1_048_576
const BALLAST_OVERSHOOT_BYTES = 2 * 1_048_576
const BALLAST_TOP_UP_ROUNDS = 6
const CATALOGUE_INDEX = 'catalogue'
const PROPAGATION_TIMEOUT_MS = 20_000
const BATCH_DOCUMENTS = 2_000
const FULL_TABLE_ENTRIES = 65_536
const DOUBLED_TABLE_BYTES = 3_670_056
const TABLES_PER_DOCUMENT_ON_ONE_PARTITION = 3
const DOUBLING_BYTES = TABLES_PER_DOCUMENT_ON_ONE_PARTITION * DOUBLED_TABLE_BYTES
const CHURNED_TABLE_ENTRIES = 40_000
const REPLACEMENTS_BEFORE_DOUBLING = 25_537
const REMOVED_TO_A_QUARTER = 49_152
const REBUILT_TABLE_BYTES = 1_835_048
const REBUILDING_BYTES = TABLES_PER_DOCUMENT_ON_ONE_PARTITION * REBUILT_TABLE_BYTES
const ROOM_LEFT_BELOW_REBUILDING_BYTES = 4 * 1_048_576

function itemId(serial: number): string {
  return `item-${serial}`
}

function serials(first: number, count: number): number[] {
  return Array.from({ length: count }, (_, offset) => first + offset)
}

async function startCatalogueNode(etcdEndpoint: string): Promise<NodeProcess> {
  const started = await startNodeProcess({
    nodeId: 'node-1',
    etcdEndpoint,
    keyPrefix: `_narsil_document_tables_${randomUUID()}`,
    heapMegabytes: HEAP_MEGABYTES,
    memory: MEMORY,
  })
  const created = await request(started.base, 'POST', '/indexes', {
    name: CATALOGUE_INDEX,
    config: { schema: { title: 'string' } },
  })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  await waitFor(`${CATALOGUE_INDEX} to have an active primary`, PROPAGATION_TIMEOUT_MS, async () => {
    const reply = await request(started.base, 'GET', `/indexes/${CATALOGUE_INDEX}/cluster`)
    const partitions = (reply.body.partitions ?? []) as Array<{ state: string }>
    return partitions.length > 0 && partitions.every(partition => partition.state === 'ACTIVE')
  })
  return started
}

async function insertItems(base: string, items: number[]): Promise<void> {
  for (let next = 0; next < items.length; next += BATCH_DOCUMENTS) {
    const documents = items.slice(next, next + BATCH_DOCUMENTS).map(serial => ({
      id: itemId(serial),
      title: `Oak chair ${serial}`,
    }))
    const reply = await request(base, 'POST', `/indexes/${CATALOGUE_INDEX}/documents/_batch`, { documents })
    expect(reply.status, JSON.stringify(reply.body).slice(0, 500)).toBe(200)
    expect(reply.body.failed, `the node refused part of the catalogue at ${documents[0].id}`).toEqual([])
  }
}

async function removeItems(base: string, items: number[]): Promise<void> {
  const reply = await request(base, 'POST', `/indexes/${CATALOGUE_INDEX}/documents/_batch`, {
    action: 'delete',
    docIds: items.map(itemId),
  })
  expect(reply.status, JSON.stringify(reply.body).slice(0, 500)).toBe(200)
  expect(reply.body.failed, `the node refused a removal at ${itemId(items[0])}`).toEqual([])
}

async function countOf(base: string): Promise<unknown> {
  return (await request(base, 'GET', `/indexes/${CATALOGUE_INDEX}/count`)).body.count
}

async function leaveHeapRoom(base: string, roomLeftBytes = ROOM_LEFT_BYTES): Promise<void> {
  const targetBytes = HEAP_BLOCK_FRACTION * HEAP_LIMIT_BYTES - roomLeftBytes
  for (let round = 0; round < BALLAST_TOP_UP_ROUNDS; round++) {
    const response = await fetch(`${base}/indexes`, {
      headers: { 'x-narsil-test-ballast': String(targetBytes / HEAP_LIMIT_BYTES) },
    })
    const body = (await response.json()) as { error?: { code?: string; message?: string } }
    expect(response.status, JSON.stringify(body)).toBe(409)
    const heldBytes = Number(body.error?.message)
    expect(heldBytes, 'the heap before the ballast already passed the target').toBeLessThan(
      targetBytes + BALLAST_OVERSHOOT_BYTES,
    )
  }
}

async function expectTableWriteRefused(base: string, refused: number, tableBytes: number): Promise<void> {
  const crossing = await request(base, 'POST', `/indexes/${CATALOGUE_INDEX}/documents`, {
    id: itemId(refused),
    document: { title: `Oak chair ${refused}` },
  })
  expect(crossing.status, `the write that replaces the tables: ${JSON.stringify(crossing.body)}`).toBe(429)
  const { code, details } = errorOf(crossing)
  expect(code).toBe('CLUSTER_WRITE_BLOCKED')
  expect(details.reason).toBe('write_would_fill_memory')
  const documentBytes = details.documentBytes as number
  const room =
    (details.blockBytes as number) -
    (details.heapBytes as number) -
    (details.youngHeapBytes as number) -
    (details.projectedBytes as number)
  expect(room, 'the refused document alone fits the heap room').toBeGreaterThanOrEqual(documentBytes)
  expect(room, 'the heap room holds the document and every new table').toBeLessThan(documentBytes + tableBytes)
  expect((await request(base, 'GET', `/indexes/${CATALOGUE_INDEX}/documents/${itemId(refused)}`)).status).toBe(404)
}

async function expectDoublingWriteRefused(base: string, admitted: number, refused: number): Promise<void> {
  const before = await request(base, 'POST', `/indexes/${CATALOGUE_INDEX}/documents`, {
    id: itemId(admitted),
    document: { title: `Oak chair ${admitted}` },
  })
  expect(before.status, `the write that fills the table: ${JSON.stringify(before.body)}`).toBe(201)
  await expectTableWriteRefused(base, refused, DOUBLING_BYTES)
  expect((await request(base, 'GET', `/indexes/${CATALOGUE_INDEX}/documents/${itemId(admitted)}`)).status).toBe(200)
}

describe('a cluster node near its memory limit, holding an index whose document tables are full', () => {
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

  it('admits document 65,536 and refuses document 65,537, which doubles every document table', async () => {
    if (container === null) throw new Error('etcd never started')
    const started = await startCatalogueNode(container.endpoint)
    node = started

    await insertItems(started.base, serials(0, FULL_TABLE_ENTRIES - 1))
    await leaveHeapRoom(started.base)
    await expectDoublingWriteRefused(started.base, FULL_TABLE_ENTRIES - 1, FULL_TABLE_ENTRIES)

    expect(await countOf(started.base)).toBe(FULL_TABLE_ENTRIES)
    expect(started.exited(), started.output()).toBe(false)
  }, 600_000)

  it('refuses replacement 25,537 of 40,000 documents, which doubles every document table', async () => {
    if (container === null) throw new Error('etcd never started')
    const started = await startCatalogueNode(container.endpoint)
    node = started

    await insertItems(started.base, serials(0, CHURNED_TABLE_ENTRIES))
    const replacedFreely = REPLACEMENTS_BEFORE_DOUBLING - 2
    for (let next = 0; next < replacedFreely; next += BATCH_DOCUMENTS) {
      const size = Math.min(BATCH_DOCUMENTS, replacedFreely - next)
      await removeItems(started.base, serials(next, size))
      await insertItems(started.base, serials(CHURNED_TABLE_ENTRIES + next, size))
    }
    await removeItems(started.base, serials(replacedFreely, 2))
    expect(await countOf(started.base)).toBe(CHURNED_TABLE_ENTRIES - 2)

    await leaveHeapRoom(started.base)
    await expectDoublingWriteRefused(
      started.base,
      CHURNED_TABLE_ENTRIES + replacedFreely,
      CHURNED_TABLE_ENTRIES + replacedFreely + 1,
    )

    expect(await countOf(started.base)).toBe(CHURNED_TABLE_ENTRIES - 1)
    expect(started.exited(), started.output()).toBe(false)
  }, 600_000)

  it('refuses the first write after removing three quarters of a full table, which rebuilds every document table at its size', async () => {
    if (container === null) throw new Error('etcd never started')
    const started = await startCatalogueNode(container.endpoint)
    node = started

    await insertItems(started.base, serials(0, FULL_TABLE_ENTRIES))
    for (let next = 0; next < REMOVED_TO_A_QUARTER; next += BATCH_DOCUMENTS) {
      await removeItems(started.base, serials(next, Math.min(BATCH_DOCUMENTS, REMOVED_TO_A_QUARTER - next)))
    }
    expect(await countOf(started.base)).toBe(FULL_TABLE_ENTRIES - REMOVED_TO_A_QUARTER)

    await leaveHeapRoom(started.base, ROOM_LEFT_BELOW_REBUILDING_BYTES)
    await expectTableWriteRefused(started.base, FULL_TABLE_ENTRIES, REBUILDING_BYTES)

    expect(await countOf(started.base)).toBe(FULL_TABLE_ENTRIES - REMOVED_TO_A_QUARTER)
    expect(started.exited(), started.output()).toBe(false)
  }, 600_000)
})
