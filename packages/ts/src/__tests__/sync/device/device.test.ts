import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { QueuedWrite, RefusedWrite, UploadOutcome } from '../../../sync/device'
import {
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

const SEEDED = 60
const NETWORK_CUT_TEST_TIMEOUT_MS = 30_000

describe('a synced device', () => {
  let directory: { path: string; remove(): Promise<void> } | null = null
  let server: SyncServer | null = null
  const devices: TestDevice[] = []

  function serving(): SyncServer {
    if (server === null) throw new Error('The server has not started')
    return server
  }

  async function seed(): Promise<Map<string, Note>> {
    const oracle = new Map<string, Note>()
    await serving().admin.createIndex(INDEX, SCHEMA)
    const batch = []
    for (let at = 0; at < SEEDED; at++) {
      oracle.set(`n${at}`, note(`n${at}`))
      batch.push({ id: `n${at}`, ...note(`n${at}`) })
    }
    await serving().admin.insertBatch(INDEX, batch)
    await serving().admin.updateSync(INDEX, { enabled: true })
    return oracle
  }

  async function device(label: string, extra: Parameters<typeof startDevice>[2] = {}): Promise<TestDevice> {
    if (directory === null) throw new Error('No directory')
    const started = await startDevice(serving().proxy.url, join(directory.path, label), extra)
    devices.push(started)
    return started
  }

  beforeEach(async () => {
    directory = await temporaryDirectory('sync')
    server = await startSyncServer(join(directory.path, 'server'))
  })

  afterEach(async () => {
    for (const started of devices.splice(0)) await started.close()
    await server?.stop()
    server = null
    await directory?.remove()
    directory = null
  })

  it(
    'converges with the server after offline writes from two devices and direct writes to the server',
    async () => {
      const oracle = await seed()
      const first = await device('first')
      const second = await device('second')
      await settledWithin(first.sync)
      await settledWithin(second.sync)
      expect(sorted(await documentsOf(first.engine, INDEX))).toEqual(sorted(oracle))

      serving().proxy.cut()
      await first.sync.put('n1', note('first offline edit'))
      await first.sync.remove('n2')
      await first.sync.put('offline-new', note('offline-new'))
      await first.sync.remove('never-existed')
      const local = await first.engine.query(INDEX, { term: 'offline' })
      expect(local.hits.map(hit => hit.id).sort()).toEqual(['n1', 'offline-new'])
      expect(first.sync.status().queuedWrites).toBe(4)

      await serving().admin.put(INDEX, 'n3', { ...note('server edit') })
      await serving().admin.remove(INDEX, 'n4')
      await serving().admin.put(INDEX, 'n1', { ...note('server edit that the offline device replaces') })
      serving().proxy.heal()
      await second.sync.put('n5', note('second device edit'))
      await second.sync.remove('n6')

      oracle.set('n1', note('first offline edit'))
      oracle.delete('n2')
      oracle.set('offline-new', note('offline-new'))
      oracle.set('n3', note('server edit'))
      oracle.delete('n4')
      oracle.set('n5', note('second device edit'))
      oracle.delete('n6')

      await settledWithin(first.sync)
      await settledWithin(second.sync)
      await settledWithin(first.sync)
      expect(sorted(await documentsOf(serving().running.engine, INDEX))).toEqual(sorted(oracle))
      expect(sorted(await documentsOf(first.engine, INDEX))).toEqual(sorted(oracle))
      expect(sorted(await documentsOf(second.engine, INDEX))).toEqual(sorted(oracle))
      expect(first.sync.status().queuedWrites).toBe(0)
    },
    NETWORK_CUT_TEST_TIMEOUT_MS,
  )

  it('replaces a refused write with the server copy and reports it', async () => {
    await seed()
    const refused: RefusedWrite[] = []
    const upload = async (writes: readonly QueuedWrite[]): Promise<UploadOutcome[]> => {
      const outcomes: UploadOutcome[] = []
      for (const write of writes) {
        if (write.documentId === 'n7') {
          outcomes.push({ accepted: false, error: new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'locked') })
          continue
        }
        if (write.document === null) await serving().admin.remove(INDEX, write.documentId)
        else await serving().admin.put(INDEX, write.documentId, write.document)
        outcomes.push({ accepted: true })
      }
      return outcomes
    }
    const started = await device('refused', { upload, onRefusedWrite: write => refused.push(write) })
    await settledWithin(started.sync)

    await started.sync.put('n7', note('an edit the backend refuses'))
    await started.sync.put('n8', note('an edit the backend accepts'))
    await settledWithin(started.sync)

    expect(await started.engine.get(INDEX, 'n7')).toMatchObject(note('n7'))
    expect(await started.engine.get(INDEX, 'n8')).toMatchObject(note('an edit the backend accepts'))
    expect(await serving().running.engine.get(INDEX, 'n8')).toMatchObject(note('an edit the backend accepts'))
    expect(refused).toHaveLength(1)
    expect(refused[0]?.write.documentId).toBe('n7')
    expect(refused[0]?.serverDocument).toMatchObject(note('n7'))
  })

  it(
    'carries on after the server restarts and keeps the writes that it queued meanwhile',
    async () => {
      const oracle = await seed()
      const started = await device('restart')
      await settledWithin(started.sync)

      serving().proxy.cut()
      await started.sync.put('during-restart', note('during-restart'))
      await serving().restart()
      await serving().admin.put(INDEX, 'after-restart', { ...note('after-restart') })
      serving().proxy.heal()

      oracle.set('during-restart', note('during-restart'))
      oracle.set('after-restart', note('after-restart'))
      await settledWithin(started.sync)
      expect(sorted(await documentsOf(started.engine, INDEX))).toEqual(sorted(oracle))
      expect(sorted(await documentsOf(serving().running.engine, INDEX))).toEqual(sorted(oracle))
    },
    NETWORK_CUT_TEST_TIMEOUT_MS,
  )

  it(
    "carries vectors both ways on an index with a vector field, so each side finds the other side's document by its vector",
    async () => {
      const vectorOf = (at: number): number[] => [at % 2 === 0 ? 1 : -1, at / 8, 0.25, at % 3 === 0 ? 0 : -(at % 3) / 4]
      const oracle = new Map<string, number[]>()
      await serving().admin.createIndex(INDEX, { schema: { title: 'string', embedding: 'vector[4]' } })
      const batch = []
      for (let at = 0; at < 12; at++) {
        oracle.set(`v${at}`, vectorOf(at))
        batch.push({ id: `v${at}`, title: `vector note ${at}`, embedding: vectorOf(at) })
      }
      await serving().admin.insertBatch(INDEX, batch)
      await serving().admin.updateSync(INDEX, { enabled: true })
      const started = await device('vectors')
      await settledWithin(started.sync)

      const fromServer = [0.5, -0.5, 0.75, 1]
      await serving().running.engine.insert(
        INDEX,
        { title: 'written on the server', embedding: new Float32Array(fromServer) },
        'from-server',
      )
      const fromDevice = [-1, 0.125, -0.75, 0.5]
      await started.sync.put('from-device', {
        title: 'written on the device',
        embedding: new Float32Array(fromDevice),
      })
      oracle.set('from-server', fromServer)
      oracle.set('from-device', fromDevice)
      await settledWithin(started.sync)

      for (const engine of [started.engine, serving().running.engine]) {
        expect(await engine.countDocuments(INDEX)).toBe(oracle.size)
        for (const [id, vector] of oracle) {
          const held = (await engine.get(INDEX, id))?.embedding as ArrayLike<number> | undefined
          expect(held === undefined ? undefined : Array.from(held)).toEqual(vector)
        }
        for (const id of ['from-server', 'from-device']) {
          const found = await engine.query(INDEX, {
            vector: { field: 'embedding', value: oracle.get(id) ?? [] },
            limit: 1,
          })
          expect(found.hits[0]?.id).toBe(id)
        }
      }
      expect(started.sync.status().queuedWrites).toBe(0)
    },
    NETWORK_CUT_TEST_TIMEOUT_MS,
  )
})
