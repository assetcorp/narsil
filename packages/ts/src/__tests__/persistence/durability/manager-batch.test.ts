import { mkdtemp, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NarsilError } from '../../../errors'
import { readCommitMarker } from '../../../persistence/durability/commit-marker'
import { createDurableDirectory, type DurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { createDurabilityManager } from '../../../persistence/durability/manager'
import type { IndexDurabilityHooks, MutationRecord } from '../../../persistence/durability/types'
import { readDurableRegion, readTailBeyondFrontier } from '../../../persistence/durability/wal-framing'

function inertHooks(): IndexDurabilityHooks {
  return {
    getManager: () => undefined,
    getVectorFieldPaths: () => new Set(),
    getVectorIndexes: () => new Map(),
    buildMetadata: () => undefined,
    createIndexFromMetadata: async () => undefined,
    onFatalError: () => undefined,
  }
}

function mutation(partitionId: number, documentId: string, apply: () => Promise<void> = async () => undefined) {
  const record: MutationRecord = {
    indexName: 'movies',
    partitionId,
    operation: 'INDEX',
    documentId,
    document: new Uint8Array([1, 2, 3]),
    apply,
  }
  return record
}

function countSyncs(directory: DurableDirectory): { syncs: number } {
  const counter = { syncs: 0 }
  const realAppendHandle = directory.appendHandle.bind(directory)
  vi.spyOn(directory, 'appendHandle').mockImplementation(async key => {
    const handle = await realAppendHandle(key)
    return {
      ...handle,
      sync: async () => {
        counter.syncs += 1
        await handle.sync()
      },
    }
  })
  return counter
}

async function loggedDocumentIds(directory: DurableDirectory, partitionId: number): Promise<string[]> {
  const prefix = `movies/wal/${partitionId}/`
  const markerBytes = await directory.read(`${prefix}commit`)
  if (markerBytes === null) return []
  const marker = readCommitMarker(markerBytes)
  if (marker === null) return []
  const keys = (await directory.list(prefix)).filter(key => /\/\d{16}$/.test(key)).sort()
  const ids: string[] = []
  for (const key of keys) {
    const bytes = await directory.read(key)
    if (bytes === null) continue
    const durable = readDurableRegion(bytes, marker.state.durableByteLength)
    const lastDurableSeqNo = durable.length > 0 ? durable[durable.length - 1].seqNo : 0
    const tail = readTailBeyondFrontier(bytes, marker.state.durableByteLength, lastDurableSeqNo)
    ids.push(...durable.map(e => e.documentId), ...tail.entries.map(e => e.documentId))
  }
  return ids
}

describe('durability manager batch recording', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-mgr-batch-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('syncs once per partition for a whole batch in sync mode', async () => {
    const directory = createDurableDirectory(root)
    const counter = countSyncs(directory)
    const manager = createDurabilityManager(
      { directory: root, mode: 'sync', checkpointIntervalMs: 0 },
      inertHooks(),
      directory,
    )
    await manager.recordMutations([mutation(0, 'warm-0'), mutation(1, 'warm-1')])
    const syncsBeforeBatch = counter.syncs

    const records = Array.from({ length: 200 }, (_, i) => mutation(i % 2, `doc-${i}`))
    const outcomes = await manager.recordMutations(records)

    expect(counter.syncs - syncsBeforeBatch).toBe(2)
    expect(outcomes.every(outcome => outcome.ok)).toBe(true)
    const seqNosOfPartitionZero = outcomes
      .filter((_, i) => i % 2 === 0)
      .map(outcome => (outcome.ok ? outcome.seqNo : -1))
    expect(seqNosOfPartitionZero).toEqual(Array.from({ length: 100 }, (_, i) => i + 2))
    expect(manager.highestPersistedSeqNo('movies', 0)).toBe(101)
    expect(manager.highestPersistedSeqNo('movies', 1)).toBe(101)

    await manager.shutdown()
    expect(await loggedDocumentIds(directory, 0)).toEqual([
      'warm-0',
      ...records.filter((_, i) => i % 2 === 0).map(r => r.documentId),
    ])
  })

  it('reports an apply failure for that record alone and logs the rest', async () => {
    const directory = createDurableDirectory(root)
    const manager = createDurabilityManager(
      { directory: root, mode: 'sync', checkpointIntervalMs: 0 },
      inertHooks(),
      directory,
    )
    const refused = new Error('refused by the partition')

    const outcomes = await manager.recordMutations([
      mutation(0, 'a'),
      mutation(0, 'b', async () => {
        throw refused
      }),
      mutation(0, 'c'),
    ])

    expect(outcomes[0]).toEqual({ ok: true, seqNo: 1 })
    expect(outcomes[1]).toEqual({ ok: false, error: refused })
    expect(outcomes[2]).toEqual({ ok: true, seqNo: 2 })
    await manager.shutdown()
    expect(await loggedDocumentIds(directory, 0)).toEqual(['a', 'c'])
  })

  it('fails every record of the batch when the sync fails', async () => {
    const directory = createDurableDirectory(root)
    const realAppendHandle = directory.appendHandle.bind(directory)
    vi.spyOn(directory, 'appendHandle').mockImplementation(async key => {
      const handle = await realAppendHandle(key)
      return {
        ...handle,
        sync: async () => {
          throw new NarsilError('PERSISTENCE_FSYNC_FAILED', 'injected fsync failure')
        },
      }
    })
    const manager = createDurabilityManager(
      { directory: root, mode: 'sync', checkpointIntervalMs: 0 },
      inertHooks(),
      directory,
    )

    const outcomes = await manager.recordMutations([mutation(0, 'a'), mutation(0, 'b')])

    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error).toMatchObject({ code: 'PERSISTENCE_FSYNC_FAILED' })
    }
    const afterFatal = await manager.recordMutations([mutation(1, 'c')])
    expect(afterFatal[0].ok).toBe(false)
    await manager.shutdown()
  })

  it('returns no outcome for an empty batch', async () => {
    const manager = createDurabilityManager({ directory: root, mode: 'sync', checkpointIntervalMs: 0 }, inertHooks())
    expect(await manager.recordMutations([])).toEqual([])
    await manager.shutdown()
  })

  it('leaves the frontier behind a batch whose sync fails, so no record counts as acknowledged', async () => {
    const directory = createDurableDirectory(root)
    const realAppendHandle = directory.appendHandle.bind(directory)
    let failSync = false
    vi.spyOn(directory, 'appendHandle').mockImplementation(async key => {
      const handle = await realAppendHandle(key)
      return {
        ...handle,
        sync: async () => {
          if (failSync) throw new NarsilError('PERSISTENCE_FSYNC_FAILED', 'injected fsync failure')
          await handle.sync()
        },
      }
    })
    const manager = createDurabilityManager(
      { directory: root, mode: 'sync', checkpointIntervalMs: 0 },
      inertHooks(),
      directory,
    )
    await manager.recordMutations([mutation(0, 'acknowledged')])
    failSync = true
    const outcomes = await manager.recordMutations([mutation(0, 'lost-0'), mutation(0, 'lost-1')])
    expect(outcomes.every(outcome => !outcome.ok)).toBe(true)
    await manager.shutdown()

    const markerBytes = await directory.read('movies/wal/0/commit')
    expect(markerBytes).not.toBeNull()
    if (markerBytes === null) return
    const marker = readCommitMarker(markerBytes)
    const segment = await directory.read('movies/wal/0/0000000000000001')
    expect(segment).not.toBeNull()
    if (marker === null || segment === null) return
    const durable = readDurableRegion(segment, marker.state.durableByteLength)
    expect(durable.map(entry => entry.documentId)).toEqual(['acknowledged'])
  })

  it('reads back every whole record of a batch after a crash cuts the last one short', async () => {
    const directory = createDurableDirectory(root)
    const manager = createDurabilityManager(
      { directory: root, mode: 'async', flushIntervalMs: 0, checkpointIntervalMs: 0 },
      inertHooks(),
      directory,
    )
    await manager.recordMutations(Array.from({ length: 10 }, (_, i) => mutation(0, `doc-${i}`)))

    const segmentPath = join(root, 'movies', 'wal', '0', '0000000000000001')
    const bytes = await directory.read('movies/wal/0/0000000000000001')
    expect(bytes).not.toBeNull()
    if (bytes === null) return
    await truncate(segmentPath, bytes.length - 5)
    const recovered = await loggedDocumentIds(directory, 0)
    await manager.shutdown()

    expect(recovered).toEqual(Array.from({ length: 9 }, (_, i) => `doc-${i}`))
  })
})
