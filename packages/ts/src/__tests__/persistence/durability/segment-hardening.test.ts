import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { loadMetadata } from '../../../persistence/durability/recovery'
import { directoryCheckpointStore } from '../../../persistence/durability/segment/store'
import { commitCheckpointManifest, writeCheckpointSegments } from '../../../persistence/durability/segment/write'
import type { IndexConfig } from '../../../types/schema'
import { sealEnvelope } from '../../e2e/portability/archive-oracle'
import { requireManifestOnDisk } from './manifest-on-disk'

const SCHEMA: IndexConfig = {
  schema: { title: 'string', body: 'string', year: 'number' },
  language: 'english',
  partitions: { maxDocsPerPartition: 12, maxPartitions: 4 },
}

function doc(i: number): { title: string; body: string; year: number } {
  return {
    title: `Document ${i}`,
    body: `the quick brown fox number ${i} jumps over the lazy dog`,
    year: 2000 + (i % 30),
  }
}

describe('segment durability hardening', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-seghard-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('carries forward the partitions a later checkpoint does not cover, with their segments', async () => {
    const writer = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 20; i += 1) await writer.insert('docs', doc(i), `d${i}`)
    await writer.checkpoint('docs')
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const before = await requireManifestOnDisk(directory, 'docs')
    expect(before.partitions.length).toBeGreaterThan(1)
    const metadata = await loadMetadata(directory, 'docs')
    if (metadata === null) throw new Error('metadata missing')
    const covered = before.checkpoint.filter(entry => entry.partitionId === 0)
    const store = directoryCheckpointStore(directory)

    const written = await writeCheckpointSegments({
      store,
      directory,
      metadata,
      targets: covered,
      compactionThreshold: 12,
      prior: before,
    })
    await commitCheckpointManifest(store, metadata, written, before.vectors)

    const after = await requireManifestOnDisk(directory, 'docs')
    for (const partition of before.partitions.filter(entry => entry.partitionId !== 0)) {
      expect(after.partitions.find(entry => entry.partitionId === partition.partitionId)).toEqual(partition)
      for (const segment of partition.segments) expect(await directory.read(segment.key)).not.toBeNull()
    }
    expect(after.checkpoint).toEqual(before.checkpoint)

    const reader = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    expect(await reader.countDocuments('docs')).toBe(20)
    await reader.shutdown()
  })

  it('reclaims an unlisted segment during recovery without losing listed data', async () => {
    const writer = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 20; i += 1) await writer.insert('docs', doc(i), `d${i}`)
    await writer.checkpoint('docs')
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const orphanKey = 'docs/segments/0/s0000000000009999'
    await directory.atomicWrite(orphanKey, sealEnvelope(4, new Uint8Array([9, 9, 9])))

    const reader = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    expect(await reader.countDocuments('docs')).toBe(20)
    expect((await reader.query('docs', { term: 'quick brown fox' })).hits.length).toBeGreaterThan(0)
    await reader.shutdown()

    expect(await directory.read(orphanKey)).toBeNull()
  })
})
