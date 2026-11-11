import { afterEach, describe, expect, it } from 'vitest'
import type { NodeRegistration } from '../../../distribution/coordinator/types'
import { NarsilError } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import {
  activeTable,
  catchUp,
  documentsOf,
  type Note,
  note,
  positionMap,
  type SyncCluster,
  startSyncCluster,
  waitFor,
} from './cluster-fixtures'
import { archivePositions, download, openFeed, ownerHook, upgradeStatus } from './fixtures'

const SCHEMA = { schema: { title: 'string', body: 'string' } } as const
const FIRST_DOCUMENTS = 200
const DATA_NODES = ['harbour-a', 'harbour-b', 'harbour-c']
const ROUTER = 'harbour-office'
const OLDER_NODE = 'harbour-older'
const CLUSTER_TEST_TIMEOUT_MS = 120_000

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    if (error instanceof NarsilError) return error.code
    throw error
  }
  return 'no error'
}

function olderRegistration(): NodeRegistration {
  return {
    nodeId: OLDER_NODE,
    address: `${OLDER_NODE}:9200`,
    roles: ['coordinator'],
    capacity: { memoryBytes: 8_000_000_000, cpuCores: 4, diskBytes: 100_000_000_000 },
    startedAt: '2026-10-01T00:00:00.000Z',
    version: '1.2',
  }
}

describe('device sync served by a cluster', () => {
  let cluster: SyncCluster | null = null
  const devices: Narsil[] = []

  async function startCluster(backups: boolean): Promise<SyncCluster> {
    const started = await startSyncCluster({ backups })
    cluster = started
    await started.start(ROUTER, ['coordinator', 'controller'])
    for (const nodeId of DATA_NODES) await started.start(nodeId, ['data'])
    return started
  }

  async function seed(running: SyncCluster, index: string): Promise<Map<string, Note>> {
    const oracle = new Map<string, Note>()
    await running.admin.createIndex(index, SCHEMA)
    await activeTable(running.coordinator, index)
    const batch = []
    for (let at = 0; at < FIRST_DOCUMENTS; at++) {
      oracle.set(`n${at}`, note(at))
      batch.push({ id: `n${at}`, ...note(at) })
    }
    expect((await running.admin.insertBatch(index, batch)).failed).toEqual([])
    return oracle
  }

  async function deviceFrom(bytes: Uint8Array, index: string): Promise<Narsil> {
    const device = await createNarsil({ workers: { enabled: false } })
    devices.push(device)
    await device.restore(index, bytes)
    return device
  }

  afterEach(async () => {
    for (const device of devices.splice(0)) await device.shutdown()
    await cluster?.dispose()
    cluster = null
  })

  it(
    'refuses to turn sync on without a backup store, and while a node registers below version 1.3',
    async () => {
      const bare = await startCluster(false)
      await bare.serve(ROUTER, ownerHook())
      await seed(bare, 'alice')
      expect(await codeOf(bare.admin.updateSync('alice', { enabled: true }))).toBe('SYNC_BACKUP_STORE_REQUIRED')
      expect((await bare.node(ROUTER).getSync('alice')).enabled).toBe(false)
      await bare.dispose()
      cluster = null

      const running = await startCluster(true)
      const base = await running.serve(ROUTER, ownerHook())
      await seed(running, 'alice')
      await running.coordinator.registerNode(olderRegistration())
      expect(await codeOf(running.admin.updateSync('alice', { enabled: true }))).toBe('SYNC_NOT_READY')
      await running.coordinator.deregisterNode(OLDER_NODE)
      await running.admin.updateSync('alice', { enabled: true })
      await running.coordinator.registerNode(olderRegistration())
      expect(await upgradeStatus(base, '/indexes/alice/sync/feed', 'narsil.sync.v1, alice-token')).toBe(503)
    },
    CLUSTER_TEST_TIMEOUT_MS,
  )

  it(
    'builds the first copy from a backup that resumes on another node, then feeds every later write through a node that leads no partition, across a failover',
    async () => {
      const running = await startCluster(true)
      const owners = ownerHook()
      const routerBase = await running.serve(ROUTER, owners)
      const dataBase = await running.serve('harbour-b', owners)
      const oracle = await seed(running, 'alice')
      await running.admin.updateSync('alice', { enabled: true })
      expect((await running.node(ROUTER).getSync('alice')).active).toBe(false)

      const preparing = await download(routerBase, 'alice', 'alice-token')
      expect(preparing.status).toBe(503)
      expect(preparing.headers.get('retry-after')).toBe('5')
      expect(JSON.parse(new TextDecoder().decode(preparing.bytes)).error.code).toBe('SYNC_SNAPSHOT_PREPARING')
      expect((await running.node(ROUTER).getSync('alice')).active).toBe(true)

      const whole = await waitFor('a backup that qualifies for the snapshot', async () => {
        const answer = await download(routerBase, 'alice', 'alice-token')
        return answer.status === 200 ? answer : null
      })
      const entityTag = whole.headers.get('etag') ?? ''
      expect(entityTag).toMatch(/^"[0-9a-f]{64}"$/)
      const cut = Math.floor(whole.bytes.byteLength / 2)
      const head = await download(routerBase, 'alice', 'alice-token', { range: `bytes=0-${cut - 1}` })
      const tail = await download(dataBase, 'alice', 'alice-token', { range: `bytes=${cut}-`, 'if-range': entityTag })
      expect(tail.status).toBe(206)
      expect(Buffer.concat([head.bytes, tail.bytes]).equals(Buffer.from(whole.bytes))).toBe(true)
      expect((await download(dataBase, 'alice', 'bob-token')).status).toBe(403)

      const device = await deviceFrom(whole.bytes, 'alice')
      expect(await documentsOf(device, 'alice')).toEqual(oracle)
      const positions = await archivePositions(whole.bytes)
      expect(positions.map(position => position.partitionId)).toEqual([0, 1])

      for (let at = FIRST_DOCUMENTS; at < FIRST_DOCUMENTS + 40; at++) {
        oracle.set(`n${at}`, note(at))
        await running.admin.put('alice', `n${at}`, note(at))
      }
      for (let at = 0; at < 25; at++) {
        oracle.delete(`n${at}`)
        await running.admin.remove('alice', `n${at}`)
      }

      const status = await running.node(ROUTER).getSync('alice')
      const feed = await openFeed(routerBase, 'alice', 'alice-token')
      feed.send({ type: 'subscribe', epoch: status.epoch, positions })
      const subscribed = await feed.next('subscribed')
      expect(subscribed.partitionCount).toBe(2)
      expect(subscribed.bytesBehind).toBeGreaterThan(0)
      const reached = positionMap(positions)
      await catchUp(feed, device, 'alice', reached)
      expect(await documentsOf(device, 'alice')).toEqual(oracle)

      const before = await activeTable(running.coordinator, 'alice')
      const leader = before.assignments.get(0)?.primary
      if (leader === null || leader === undefined) throw new Error('partition 0 has no primary')
      await running.stop(leader)
      await waitFor('a new primary for partition 0', async () => {
        const assignment = (await running.coordinator.getAllocation('alice'))?.assignments.get(0)
        return assignment?.state === 'ACTIVE' && assignment.primary !== null && assignment.primary !== leader
      })
      for (let at = 30; at < 60; at++) {
        const edited = { title: `edited note ${at}`, body: 'changed after the failover' }
        oracle.set(`n${at}`, edited)
        await running.admin.put('alice', `n${at}`, edited)
      }
      await catchUp(feed, device, 'alice', reached)
      expect(await documentsOf(device, 'alice')).toEqual(oracle)
      feed.close()
    },
    CLUSTER_TEST_TIMEOUT_MS,
  )
})
