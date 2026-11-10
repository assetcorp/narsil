import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import type { Narsil } from '../../types/engine'
import { scaledOut, waitFor } from '../server/helpers'
import { expectLayout as expectTitledLayout, idsFrom } from './partition-layout-oracle'

const WORKERS_BUILT = existsSync(new URL('../../../dist/workers/entry.mjs', import.meta.url))
const INDEX = 'items'
const MAX_PARTITIONS = 8
const SHRUNK_PARTITIONS = 3
const GROWN_PARTITIONS = 4
const FIRST_DOCUMENTS = 600
const LATER_DOCUMENTS = 90
const CONCURRENT_REPLACEMENTS = 120
const WORKER_COPY_DOCUMENTS = 1_500
const REPLICATION_SETTLE_MS = 15_000
const REPLICATION_POLL_MS = 50

function expectLayout(engine: Narsil, ids: readonly string[], partitionCount: number): Promise<void> {
  return expectTitledLayout(engine, INDEX, new Map(ids.map(id => [id, `alpha ${id}`])), partitionCount)
}

async function insertAll(engine: Narsil, ids: readonly string[]): Promise<void> {
  const result = await engine.insertBatch(
    INDEX,
    ids.map(id => ({ id, title: `alpha ${id}` })),
  )
  expect(result.failed).toEqual([])
}

describe('an index keeps the partition count of its saved state', { timeout: 120_000 }, () => {
  let directory = ''
  let engine: Narsil | null = null

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    if (directory.length > 0) await rm(directory, { recursive: true, force: true })
    directory = ''
  })

  async function open(config: NarsilConfig = {}): Promise<Narsil> {
    await engine?.shutdown()
    engine = null
    if (directory.length === 0) directory = await mkdtemp(join(tmpdir(), 'narsil-saved-layout-'))
    const running = await createNarsil({ workers: { enabled: false }, durability: { directory }, ...config })
    engine = running
    return running
  }

  async function shrunkIndex(running: Narsil): Promise<string[]> {
    await running.createIndex(INDEX, { schema: { title: 'string' }, partitions: { maxPartitions: MAX_PARTITIONS } })
    const ids = idsFrom('d', 0, FIRST_DOCUMENTS)
    await insertAll(running, ids)
    await running.checkpoint(INDEX)
    await running.rebalance(INDEX, SHRUNK_PARTITIONS)
    await expectLayout(running, ids, SHRUNK_PARTITIONS)
    return ids
  }

  it('restarts with the rebalanced count, and routes the writes made after the restart under it', async () => {
    const ids = await shrunkIndex(await open())

    const restarted = await open()
    await expectLayout(restarted, ids, SHRUNK_PARTITIONS)
    const later = idsFrom('later', 0, LATER_DOCUMENTS)
    await insertAll(restarted, later)
    const removed = ids.slice(0, CONCURRENT_REPLACEMENTS)
    for (const id of removed) await restarted.remove(INDEX, id)
    const kept = [...ids.slice(CONCURRENT_REPLACEMENTS), ...later]
    await expectLayout(restarted, kept, SHRUNK_PARTITIONS)
    await restarted.checkpoint(INDEX)

    const again = await open()
    await expectLayout(again, kept, SHRUNK_PARTITIONS)
    for (const id of removed) expect(await again.get(INDEX, id), id).toBeUndefined()
  })

  it('keeps every write made during a rebalance through the restart that follows it', async () => {
    const ids = await shrunkIndex(await open())
    const restarted = await open()
    const replacing = (async () => {
      for (let at = 0; at < CONCURRENT_REPLACEMENTS; at++) {
        await restarted.remove(INDEX, `d${at}`)
        await restarted.insert(INDEX, { title: `alpha n${at}` }, `n${at}`)
      }
    })()
    await Promise.all([restarted.rebalance(INDEX, GROWN_PARTITIONS), replacing])
    const expected = [...ids.slice(CONCURRENT_REPLACEMENTS), ...idsFrom('n', 0, CONCURRENT_REPLACEMENTS)]
    await expectLayout(restarted, expected, GROWN_PARTITIONS)

    const again = await open()
    await expectLayout(again, expected, GROWN_PARTITIONS)
    for (const id of idsFrom('d', 0, CONCURRENT_REPLACEMENTS)) expect(await again.get(INDEX, id), id).toBeUndefined()
  })

  it('reopens a closed index with the rebalanced count, both after close and after a restart that registers it closed', async () => {
    const running = await open({ lifecycle: {} })
    const ids = await shrunkIndex(running)
    await running.close(INDEX)
    await expectLayout(running, ids, SHRUNK_PARTITIONS)
    const later = idsFrom('later', 0, LATER_DOCUMENTS)
    await insertAll(running, later)
    await running.close(INDEX)
    await expectLayout(running, [...ids, ...later], SHRUNK_PARTITIONS)

    const restarted = await open({ lifecycle: {} })
    expect(restarted.listIndexes()).toEqual([expect.objectContaining({ name: INDEX, state: 'closed' })])
    await expectLayout(restarted, [...ids, ...later], SHRUNK_PARTITIONS)
  })

  it('restores a snapshot with the count the snapshot holds, with and without durable storage', async () => {
    const source = await open()
    const ids = await shrunkIndex(source)
    const archive = new Uint8Array(await new Response(await source.snapshot(INDEX)).arrayBuffer())

    for (const durable of [false, true]) {
      const target = await createNarsil({
        workers: { enabled: false },
        ...(durable ? { durability: { directory: await mkdtemp(join(tmpdir(), 'narsil-restored-layout-')) } } : {}),
      })
      try {
        await target.restore(INDEX, archive)
        await expectLayout(target, ids, SHRUNK_PARTITIONS)
        const later = idsFrom('later', 0, LATER_DOCUMENTS)
        await insertAll(target, later)
        await expectLayout(target, [...ids, ...later], SHRUNK_PARTITIONS)
      } finally {
        await target.shutdown()
      }
    }
  })

  it.skipIf(!WORKERS_BUILT)(
    'loads worker copies with the rebalanced count, so a search split across workers finds every later write',
    async () => {
      const running = await createNarsil({
        workers: { enabled: true, count: 2, promotionThreshold: 100, mainCopyQueries: 'none' },
      })
      engine = running
      await running.createIndex(INDEX, { schema: { title: 'string' }, partitions: { maxPartitions: MAX_PARTITIONS } })
      await insertAll(running, idsFrom('d', 0, WORKER_COPY_DOCUMENTS))
      await waitFor(() => scaledOut(running, INDEX), 30_000)
      await running.rebalance(INDEX, SHRUNK_PARTITIONS)
      await waitFor(() => scaledOut(running, INDEX), 30_000)

      const later = idsFrom('fresh', 0, LATER_DOCUMENTS)
      for (const id of later) await running.insert(INDEX, { title: `beta ${id}` }, id)
      const expected = [...later].sort()
      let found: string[] = []
      const deadline = Date.now() + REPLICATION_SETTLE_MS
      do {
        found = (await running.query(INDEX, { term: 'beta', limit: LATER_DOCUMENTS * 2 })).hits
          .map(hit => hit.id)
          .sort()
        if (found.length === expected.length) break
        await new Promise(resolve => setTimeout(resolve, REPLICATION_POLL_MS))
      } while (Date.now() < deadline)
      expect(found).toEqual(expected)
      expect(running.getPartitionStats(INDEX)).toHaveLength(SHRUNK_PARTITIONS)
    },
  )
})
