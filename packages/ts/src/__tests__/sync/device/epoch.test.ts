import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFeed } from '../../server/sync/fixtures'
import {
  DEVICE_TOKEN,
  documentsOf,
  INDEX,
  type Note,
  note,
  SCHEMA,
  type SyncServer,
  settledWithin,
  sorted,
  startDevice,
  startSyncServer,
  type TestDevice,
  temporaryDirectory,
} from './fixtures'

const SEEDED = 40
const LATER_WRITES = 300

describe('a synced device after the server copy changes under it', () => {
  let directory: { path: string; remove(): Promise<void> } | null = null
  let server: SyncServer | null = null
  const devices: TestDevice[] = []

  function serving(): SyncServer {
    if (server === null) throw new Error('The server has not started')
    return server
  }

  async function seed(historyMaxBytes?: number): Promise<Map<string, Note>> {
    const oracle = new Map<string, Note>()
    await serving().admin.createIndex(INDEX, SCHEMA)
    const batch = []
    for (let at = 0; at < SEEDED; at++) {
      oracle.set(`n${at}`, note(`n${at}`))
      batch.push({ id: `n${at}`, ...note(`n${at}`) })
    }
    await serving().admin.insertBatch(INDEX, batch)
    await serving().admin.updateSync(INDEX, {
      enabled: true,
      ...(historyMaxBytes === undefined ? {} : { historyMaxBytes }),
    })
    return oracle
  }

  async function device(label: string): Promise<TestDevice> {
    if (directory === null) throw new Error('No directory')
    const started = await startDevice(serving().proxy.url, join(directory.path, label))
    devices.push(started)
    return started
  }

  async function writeMany(oracle: Map<string, Note>, prefix: string): Promise<void> {
    for (let at = 0; at < LATER_WRITES; at += 50) {
      const batch = []
      for (let offset = at; offset < at + 50; offset++) {
        oracle.set(`${prefix}${offset}`, note(`${prefix}${offset}`))
        batch.push({ id: `${prefix}${offset}`, ...note(`${prefix}${offset}`) })
      }
      await serving().admin.insertBatch(INDEX, batch)
      await serving().admin.checkpoint(INDEX)
    }
  }

  beforeEach(async () => {
    directory = await temporaryDirectory('epoch')
    server = await startSyncServer(join(directory.path, 'server'))
  })

  afterEach(async () => {
    for (const started of devices.splice(0)) await started.close()
    await server?.stop()
    server = null
    await directory?.remove()
    directory = null
  })

  it('loads the published snapshot once it falls behind the history and keeps its queued write', async () => {
    const oracle = await seed(1)
    const started = await device('behind')
    await settledWithin(started.sync)
    await started.sync.stop()
    const saved = started.sync.status().position
    if (saved === null) throw new Error('The device saved no position')

    await started.sync.put('queued-offline', note('queued-offline'))
    oracle.set('queued-offline', note('queued-offline'))
    await writeMany(oracle, 'later')

    const probe = await openFeed(serving().running.base, INDEX, DEVICE_TOKEN)
    probe.send({
      type: 'subscribe',
      epoch: saved.epoch,
      positions: saved.seqNos.map((seqNo, partitionId) => ({ partitionId, seqNo })),
    })
    expect(await probe.next('resync')).toMatchObject({ reason: 'history' })
    probe.close()

    await started.sync.start()
    await settledWithin(started.sync)
    expect(sorted(await documentsOf(started.engine, INDEX))).toEqual(sorted(oracle))
    expect(sorted(await documentsOf(serving().running.engine, INDEX))).toEqual(sorted(oracle))
  })

  it('loads a new copy after a rebalance that happened while it was offline and keeps its queued write', async () => {
    const oracle = await seed()
    const started = await device('offline-rebalance')
    await settledWithin(started.sync)
    await started.sync.stop()
    await started.sync.put('queued-offline', note('queued-offline'))
    oracle.set('queued-offline', note('queued-offline'))

    const rebalance = await serving().admin.rebalance(INDEX, 3)
    await serving().admin.waitForTask(rebalance.id)
    await serving().admin.put(INDEX, 'after-rebalance', { ...note('after-rebalance') })
    oracle.set('after-rebalance', note('after-rebalance'))

    await started.sync.start()
    await settledWithin(started.sync)
    expect(started.sync.status().position?.seqNos).toHaveLength(3)
    expect(sorted(await documentsOf(started.engine, INDEX))).toEqual(sorted(oracle))
    expect(sorted(await documentsOf(serving().running.engine, INDEX))).toEqual(sorted(oracle))
  })

  it('follows a rebalance, a clear, and a restore of the server index to a new copy each time', async () => {
    const oracle = await seed()
    const started = await device('epochs')
    await settledWithin(started.sync)
    const firstEpoch = started.sync.status().position?.epoch
    const firstPartitionCount = started.sync.status().position?.seqNos.length
    expect(firstPartitionCount).toBe(1)

    const snapshot = new Uint8Array(await new Response(await serving().admin.snapshot(INDEX)).arrayBuffer())
    const snapshotOracle = new Map(oracle)

    const rebalance = await serving().admin.rebalance(INDEX, 3)
    await serving().admin.waitForTask(rebalance.id)
    await serving().admin.put(INDEX, 'after-rebalance', { ...note('after-rebalance') })
    oracle.set('after-rebalance', note('after-rebalance'))
    await settledWithin(started.sync)
    expect(started.sync.status().position?.seqNos).toHaveLength(3)
    expect(started.sync.status().position?.epoch).not.toBe(firstEpoch)
    expect(sorted(await documentsOf(started.engine, INDEX))).toEqual(sorted(oracle))

    await serving().admin.clear(INDEX)
    await serving().admin.put(INDEX, 'after-clear', { ...note('after-clear') })
    await settledWithin(started.sync)
    expect(sorted(await documentsOf(started.engine, INDEX))).toEqual([['after-clear', note('after-clear')]])

    const restore = await serving().admin.restore(INDEX, snapshot)
    await serving().admin.waitForTask(restore.id)
    await settledWithin(started.sync)
    expect(sorted(await documentsOf(started.engine, INDEX))).toEqual(sorted(snapshotOracle))
    expect(started.sync.status().position?.seqNos).toHaveLength(1)
  })
})
