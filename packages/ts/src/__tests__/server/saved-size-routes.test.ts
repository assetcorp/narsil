import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../client'
import {
  bodyOf,
  checkpointFileBytes,
  logFileBytes,
  partitionCheckpointFileBytes,
  partitionLogFileBytes,
  savedBytesAllowedFor,
} from '../persistence/durability/saved-size-oracle'
import { getJson, startTestServer, type TestServer } from './helpers'

const INDEX = 'letters'
const DOCUMENTS = 800
const BODY_LENGTH = 700

interface StatsBody {
  savedBytes?: unknown
  logBytes?: unknown
}

describe('the saved and log sizes over HTTP', () => {
  let directory = ''
  let running: TestServer | null = null

  function serve(): Promise<TestServer> {
    return startTestServer(undefined, {
      durability: { directory, checkpointIntervalMs: 0, checkpointMutationThreshold: 1_000_000_000 },
      workers: { enabled: false },
    })
  }

  async function expectFilesThroughTheClient(client: NarsilClient): Promise<number> {
    const stats = await client.getStats(INDEX)
    expect(stats.savedBytes).toBe(checkpointFileBytes(directory, INDEX))
    expect(stats.logBytes).toBe(logFileBytes(directory, INDEX))
    for (const partition of await client.getPartitionStats(INDEX)) {
      expect(partition.savedBytes).toBe(partitionCheckpointFileBytes(directory, INDEX, partition.partitionId))
      expect(partition.logBytes).toBe(partitionLogFileBytes(directory, INDEX, partition.partitionId))
    }
    return stats.savedBytes ?? Number.POSITIVE_INFINITY
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-saved-size-routes-'))
  })

  afterEach(async () => {
    if (running !== null) {
      await running.stop()
      await running.engine.shutdown()
    }
    running = null
    await rm(directory, { recursive: true, force: true })
  })

  it('match the files through the published client, fall after removals, and survive a server restart', async () => {
    running = await serve()
    const client = createNarsilClient({ url: running.base })
    await client.createIndex(INDEX, { schema: { title: 'string', body: 'string' }, partitions: { maxPartitions: 2 } })
    const documents = Array.from({ length: DOCUMENTS }, (_, at) => ({
      id: `letter-${at}`,
      title: `letter ${at}`,
      body: bodyOf(at, BODY_LENGTH),
    }))
    expect((await client.insertBatch(INDEX, documents)).failed).toEqual([])
    await client.checkpoint(INDEX)
    const savedAfterInsert = await expectFilesThroughTheClient(client)

    const removed = documents.filter((_, at) => at % 3 !== 0).map(document => document.id)
    expect((await client.removeBatch(INDEX, removed)).failed).toEqual([])
    for (let round = 0; round < 3; round++) await client.checkpoint(INDEX)
    const savedAfterRemovals = await expectFilesThroughTheClient(client)
    const live = DOCUMENTS - removed.length
    expect(savedAfterRemovals).toBeLessThanOrEqual(savedBytesAllowedFor(live, savedAfterInsert / DOCUMENTS))
    expect(await client.countDocuments(INDEX)).toBe(live)

    const raw = await getJson<StatsBody>(running.base, `/indexes/${INDEX}/stats`)
    expect(raw.status).toBe(200)
    expect(raw.body.savedBytes).toBe(savedAfterRemovals)
    expect(Number.isSafeInteger(raw.body.logBytes)).toBe(true)

    await running.stop()
    await running.engine.shutdown()
    running = await serve()
    const restarted = createNarsilClient({ url: running.base })
    expect(await expectFilesThroughTheClient(restarted)).toBe(savedAfterRemovals)
  }, 60_000)
})
