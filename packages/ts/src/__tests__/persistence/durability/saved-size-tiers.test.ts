import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { createFilesystemPersistence } from '../../../persistence/filesystem'
import type { NarsilConfig } from '../../../types/config'
import { bytesOf } from '../../e2e/portability/archive-oracle'
import { bodyOf, checkpointFileBytes, expectDocumentsOf, partitionCheckpointFileBytes } from './saved-size-oracle'

const INDEX = 'notes'
const DOCUMENTS = 600
const BODY_LENGTH = 800

async function insertDocuments(engine: Narsil, expected: Map<string, string>, from = 0): Promise<void> {
  const batch = []
  for (let at = from; at < from + DOCUMENTS; at++) {
    const body = bodyOf(at, BODY_LENGTH)
    batch.push({ id: `note-${at}`, title: `title ${at}`, body })
    expected.set(`note-${at}`, body)
  }
  await engine.insertBatch(INDEX, batch)
}

function expectSavedSizeOfTheFiles(engine: Narsil, directory: string): void {
  const stats = engine.getStats(INDEX)
  expect(stats.savedBytes).toBe(checkpointFileBytes(directory, INDEX))
  expect(stats.logBytes).toBeUndefined()
  for (const partition of engine.getPartitionStats(INDEX)) {
    expect(partition.savedBytes).toBe(partitionCheckpointFileBytes(directory, INDEX, partition.partitionId))
    expect(partition.logBytes).toBeUndefined()
  }
}

describe('the saved size of an index in snapshot storage', () => {
  let directory: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-saved-size-snapshot-'))
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(directory, { recursive: true, force: true })
  })

  function config(): NarsilConfig {
    return {
      persistence: createFilesystemPersistence({ directory }),
      durability: { tier: 'snapshot', checkpointIntervalMs: 0, checkpointMutationThreshold: 1_000_000_000 },
      workers: { enabled: false },
    }
  }

  it('equals the files that its checkpoints write, across removals, a restore, and a restart, and reports no log', async () => {
    engine = await createNarsil(config())
    await engine.createIndex(INDEX, { schema: { title: 'string', body: 'string' } })
    const expected = new Map<string, string>()
    await insertDocuments(engine, expected)
    await engine.checkpoint(INDEX)
    expectSavedSizeOfTheFiles(engine, directory)
    const snapshot = await bytesOf(await engine.snapshot(INDEX))
    const snapshotExpected = new Map(expected)

    await insertDocuments(engine, expected, DOCUMENTS)
    const removed: string[] = []
    for (let at = 0; at < DOCUMENTS; at += 2) removed.push(`note-${at}`)
    await engine.removeBatch(INDEX, removed)
    for (const docId of removed) expected.delete(docId)
    await engine.checkpoint(INDEX)
    expectSavedSizeOfTheFiles(engine, directory)

    await engine.restore(INDEX, snapshot)
    await engine.checkpoint(INDEX)
    expectSavedSizeOfTheFiles(engine, directory)
    await expectDocumentsOf(engine, INDEX, snapshotExpected, [])
    const restoredBytes = engine.getStats(INDEX).savedBytes

    await engine.shutdown()
    engine = await createNarsil(config())
    expect(engine.getStats(INDEX).savedBytes).toBe(restoredBytes)
    expectSavedSizeOfTheFiles(engine, directory)
  }, 60_000)
})

describe('the saved size of a closed index', () => {
  let directory: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-saved-size-closed-'))
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(directory, { recursive: true, force: true })
  })

  function config(): NarsilConfig {
    return {
      durability: { directory, checkpointIntervalMs: 0, checkpointMutationThreshold: 1_000_000_000 },
      workers: { enabled: false },
      lifecycle: {},
    }
  }

  it('comes from the stored metadata, with no log size, until a request opens the index', async () => {
    engine = await createNarsil(config())
    await engine.createIndex(INDEX, { schema: { title: 'string', body: 'string' } })
    const expected = new Map<string, string>()
    await insertDocuments(engine, expected)
    await engine.checkpoint(INDEX)
    const savedWhileOpen = engine.getStats(INDEX).savedBytes
    expect(savedWhileOpen).toBe(checkpointFileBytes(directory, INDEX))

    await engine.close(INDEX)
    const closed = engine.getStats(INDEX)
    expect(closed.savedBytes).toBe(checkpointFileBytes(directory, INDEX))
    expect(closed.logBytes).toBeUndefined()

    await engine.shutdown()
    engine = await createNarsil(config())
    expect(engine.listIndexes()).toEqual([expect.objectContaining({ name: INDEX, state: 'closed' })])
    const afterRestart = engine.getStats(INDEX)
    expect(afterRestart.savedBytes).toBe(checkpointFileBytes(directory, INDEX))
    expect(afterRestart.logBytes).toBeUndefined()

    await expectDocumentsOf(engine, INDEX, expected, [])
    const opened = engine.getStats(INDEX)
    expect(opened.savedBytes).toBe(checkpointFileBytes(directory, INDEX))
    expect(opened.logBytes).toBeGreaterThanOrEqual(0)
  }, 60_000)
})
