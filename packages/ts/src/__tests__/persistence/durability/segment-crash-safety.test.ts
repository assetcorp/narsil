import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { readCommitMarker } from '../../../persistence/durability/commit-marker'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { loadMetadata } from '../../../persistence/durability/recovery'
import { type CheckpointStore, directoryCheckpointStore } from '../../../persistence/durability/segment/store'
import { commitCheckpointManifest, writeCheckpointSegments } from '../../../persistence/durability/segment/write'
import { SINGLE_NODE_PRIMARY_TERM } from '../../../persistence/durability/seq-owner'
import type { IndexConfig } from '../../../types/schema'
import { requireManifestOnDisk } from './manifest-on-disk'

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

function storeFailingOn(store: CheckpointStore, failOnKeySubstring: string): CheckpointStore {
  return {
    ...store,
    async write(key, chunks) {
      if (key.includes(failOnKeySubstring)) throw new Error(`simulated crash writing "${key}"`)
      return store.write(key, chunks)
    },
  }
}

async function highestDurableSeqNo(root: string, indexName: string): Promise<number> {
  const markerBytes = await createDurableDirectory(root).read(`${indexName}/wal/0/commit`)
  if (markerBytes === null) throw new Error('commit marker missing')
  const marker = readCommitMarker(markerBytes)
  if (marker === null) throw new Error('commit marker unreadable')
  return marker.state.highestDurableSeqNo
}

async function checkpointThatCrashesOnTheManifest(root: string): Promise<void> {
  const directory = createDurableDirectory(root)
  const metadata = await loadMetadata(directory, 'docs')
  if (metadata === null) throw new Error('metadata missing')
  const prior = await requireManifestOnDisk(directory, 'docs')
  const faulty = storeFailingOn(directoryCheckpointStore(directory), '/manifest')
  const written = await writeCheckpointSegments({
    store: faulty,
    directory,
    metadata,
    targets: [
      { partitionId: 0, lastSeqNo: await highestDurableSeqNo(root, 'docs'), primaryTerm: SINGLE_NODE_PRIMARY_TERM },
    ],
    compactionThreshold: 12,
    prior,
  })
  await commitCheckpointManifest(faulty, metadata, written, prior.vectors)
}

describe('segmented checkpoint crash safety', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-segcrash-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('keeps the prior checkpoint and its segments when the manifest write fails', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 30; i += 1) await writer.insert('docs', doc(i), `d${i}`)
    await writer.checkpoint('docs')
    const firstManifest = await requireManifestOnDisk(root, 'docs')
    for (let i = 30; i < 90; i += 1) await writer.insert('docs', doc(i), `d${i}`)
    await writer.shutdown()

    await expect(checkpointThatCrashesOnTheManifest(root)).rejects.toThrow(/simulated crash/)

    const manifestAfter = await requireManifestOnDisk(root, 'docs')
    expect(manifestAfter.partitions[0].segments.map(segment => segment.key)).toEqual(
      firstManifest.partitions[0].segments.map(segment => segment.key),
    )
    expect(manifestAfter.checkpoint[0].lastSeqNo).toBe(firstManifest.checkpoint[0].lastSeqNo)

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(90)
    expect(await reader.get('docs', 'd0')).toMatchObject({ title: 'Document 0' })
    expect(await reader.get('docs', 'd89')).toMatchObject({ title: 'Document 89' })
    await reader.shutdown()
  }, 30_000)
})
