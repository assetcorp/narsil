import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import type { IndexState } from '../../../persistence/durability/manager-state'
import { readSegmentManifest } from '../../../persistence/durability/segment'
import {
  checkpointIsDue,
  noteCheckpointCommitted,
  releaseStalledWrites,
  stallWhileCheckpointsFallBehind,
} from '../../../persistence/durability/write-stall'

function indexStateWith(backlogBytes: number, checkpointInFlight: Promise<void> | null): IndexState {
  return {
    partitions: new Map(),
    mutationsSinceCheckpoint: 1_000,
    documentBytesSinceCheckpoint: backlogBytes,
    checkpointInFlight,
    unloading: false,
    stalledWrites: [],
  }
}

async function settledWithin(promise: Promise<void>, turns: number): Promise<boolean> {
  let settled = false
  void promise.then(() => {
    settled = true
  })
  for (let i = 0; i < turns; i += 1) await Promise.resolve()
  return settled
}

describe('a write that arrives while checkpoints fall behind the log', () => {
  it('waits while the backlog reaches the bound and a checkpoint runs, and goes on once the backlog falls', async () => {
    const indexState = indexStateWith(200, new Promise<void>(() => undefined))
    const write = stallWhileCheckpointsFallBehind(indexState, 200)

    expect(await settledWithin(write, 5)).toBe(false)
    releaseStalledWrites(indexState)
    expect(await settledWithin(write, 5)).toBe(false)

    noteCheckpointCommitted(indexState, 400)

    expect(indexState.documentBytesSinceCheckpoint).toBe(80)
    expect(indexState.mutationsSinceCheckpoint).toBe(400)
    expect(await settledWithin(write, 5)).toBe(true)
    expect(indexState.stalledWrites).toEqual([])
  })

  it('counts no bytes once a checkpoint covers every record, and never more than it counted before', () => {
    const covered = indexStateWith(200, null)
    const replayed = indexStateWith(200, null)

    noteCheckpointCommitted(covered, 0)
    noteCheckpointCommitted(replayed, 5_000)

    expect(covered.documentBytesSinceCheckpoint).toBe(0)
    expect(replayed.documentBytesSinceCheckpoint).toBe(200)
    expect(replayed.mutationsSinceCheckpoint).toBe(5_000)
  })

  it('goes on at once by default while the backlog holds less than two gibibytes', async () => {
    const indexState = indexStateWith(1_500_000_000, new Promise<void>(() => undefined))

    expect(await settledWithin(stallWhileCheckpointsFallBehind(indexState), 5)).toBe(true)
  })

  it('goes on at once below the bound, with no checkpoint running, and while the index unloads', async () => {
    const running = new Promise<void>(() => undefined)
    const unloading = { ...indexStateWith(500, running), unloading: true }

    expect(await settledWithin(stallWhileCheckpointsFallBehind(indexStateWith(199, running), 200), 5)).toBe(true)
    expect(await settledWithin(stallWhileCheckpointsFallBehind(indexStateWith(500, null), 200), 5)).toBe(true)
    expect(await settledWithin(stallWhileCheckpointsFallBehind(unloading, 200), 5)).toBe(true)
  })

  it('calls a checkpoint due once the backlog reaches the bound, however few records hold it', () => {
    expect(checkpointIsDue(indexStateWith(200, null), 100_000, 200)).toBe(true)
    expect(checkpointIsDue(indexStateWith(199, null), 100_000, 200)).toBe(false)
    expect(checkpointIsDue(indexStateWith(0, null), 1_000, 200)).toBe(true)
  })

  it('goes on once the checkpoint ends, whatever the backlog', async () => {
    const indexState = indexStateWith(500, new Promise<void>(() => undefined))
    const write = stallWhileCheckpointsFallBehind(indexState, 200)
    expect(await settledWithin(write, 5)).toBe(false)

    indexState.checkpointInFlight = null
    releaseStalledWrites(indexState)

    expect(await settledWithin(write, 5)).toBe(true)
  })
})

describe('an import that outruns its checkpoints', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-write-stall-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('acknowledges every write and checkpoints every record', async () => {
    const engine = await createNarsil({
      durability: { directory: root, checkpointMutationThreshold: 10 },
      workers: { enabled: false },
    })
    await engine.createIndex('docs', { schema: { title: 'string' }, language: 'english' })
    const batches = []
    for (let batch = 0; batch < 12; batch += 1) {
      const documents = []
      for (let i = 0; i < 25; i += 1) documents.push({ id: `d${batch}-${i}`, title: `harbour light ${batch} ${i}` })
      batches.push(engine.insertBatch('docs', documents))
    }

    const results = await Promise.all(batches)
    await engine.checkpoint('docs')
    const manifest = await readSegmentManifest(createDurableDirectory(root), 'docs')
    await engine.shutdown()

    expect(results.flatMap(result => result.failed)).toEqual([])
    expect(manifest?.checkpoint).toEqual([{ partitionId: 0, lastSeqNo: 300, primaryTerm: 1 }])
  })
})
