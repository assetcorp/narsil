import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import {
  __failNextCheckpointWorkerForTests,
  resetCheckpointWorkerLatch,
} from '../../../persistence/durability/checkpoint-worker-dispatch'
import { readCommitMarker } from '../../../persistence/durability/commit-marker'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { rebuildSnapshotFromDurable } from '../../../persistence/durability/rebuild'
import { loadMetadata } from '../../../persistence/durability/recovery'
import { DEFAULT_COMPACTION_THRESHOLD } from '../../../persistence/durability/segment'
import { SINGLE_NODE_PRIMARY_TERM } from '../../../persistence/durability/seq-owner'
import type { IndexConfig } from '../../../types/schema'

const SCHEMA: IndexConfig = {
  schema: { title: 'string', body: 'string', year: 'number' },
  language: 'english',
}

function doc(i: number): { title: string; body: string; year: number } {
  return {
    title: `Document ${i}`,
    body: `the quick brown fox number ${i} jumps over the lazy dog`,
    year: 2000 + (i % 30),
  }
}

async function highestDurableSeqNo(root: string, indexName: string): Promise<number> {
  const directory = createDurableDirectory(root)
  const markerBytes = await directory.read(`${indexName}/wal/0/commit`)
  if (markerBytes === null) {
    throw new Error('commit marker missing')
  }
  const marker = readCommitMarker(markerBytes)
  if (marker === null) {
    throw new Error('commit marker unreadable')
  }
  return marker.state.highestDurableSeqNo
}

describe('off-thread checkpoint worker', () => {
  let root: string

  beforeEach(async () => {
    resetCheckpointWorkerLatch()
    root = await mkdtemp(join(tmpdir(), 'narsil-ckpt-worker-'))
  })

  afterEach(async () => {
    resetCheckpointWorkerLatch()
    await rm(root, { recursive: true, force: true })
  })

  it('rebuilds a recoverable snapshot off-thread and recovers the checkpoint plus later writes', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 60; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    for (let i = 60; i < 80; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(80)
    expect(await reader.get('docs', 'd0')).toMatchObject({ title: 'Document 0' })
    expect(await reader.get('docs', 'd79')).toMatchObject({ title: 'Document 79' })
    const result = await reader.query('docs', { term: 'quick brown fox' })
    expect(result.hits.length).toBeGreaterThan(0)
    await reader.shutdown()
  })

  it('falls back to the in-process path when the worker is unavailable and still recovers', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 40; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    __failNextCheckpointWorkerForTests()
    await writer.checkpoint('docs')
    for (let i = 40; i < 50; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(50)
    expect(await reader.get('docs', 'd49')).toMatchObject({ title: 'Document 49' })
    await reader.shutdown()
  })

  it('recovers correctly when a snapshot is durable but the WAL was not truncated', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 10; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    for (let i = 10; i < 20; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const metadata = await loadMetadata(directory, 'docs')
    expect(metadata).not.toBeNull()
    if (metadata === null) {
      return
    }
    const lastSeqNo = await highestDurableSeqNo(root, 'docs')

    await rebuildSnapshotFromDurable(
      root,
      metadata,
      [{ partitionId: 0, lastSeqNo, primaryTerm: SINGLE_NODE_PRIMARY_TERM }],
      DEFAULT_COMPACTION_THRESHOLD,
    )

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(20)
    expect(await reader.get('docs', 'd0')).toMatchObject({ title: 'Document 0' })
    expect(await reader.get('docs', 'd19')).toMatchObject({ title: 'Document 19' })
    await reader.shutdown()
  })

  it('rebuilds from the WAL alone when there is no prior snapshot', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 15; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const metadata = await loadMetadata(directory, 'docs')
    if (metadata === null) {
      throw new Error('metadata missing')
    }
    const lastSeqNo = await highestDurableSeqNo(root, 'docs')

    await rebuildSnapshotFromDurable(
      root,
      metadata,
      [{ partitionId: 0, lastSeqNo, primaryTerm: SINGLE_NODE_PRIMARY_TERM }],
      DEFAULT_COMPACTION_THRESHOLD,
    )
    expect(await directory.read('docs/manifest')).not.toBeNull()

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(15)
    await reader.shutdown()
  })

  it('checkpoints a freshly created empty index without error', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    await writer.checkpoint('docs')
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(0)
    await reader.shutdown()
  })
})
