import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { readCommitMarker } from '../../../persistence/durability/commit-marker'
import { createDurableDirectory, type DurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { loadMetadata } from '../../../persistence/durability/recovery'
import { decodeSegmentManifest } from '../../../persistence/durability/segment/manifest'
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

function injectAtomicWriteFault(directory: DurableDirectory, failOnKeySubstring: string): DurableDirectory {
  return {
    ...directory,
    get root() {
      return directory.root
    },
    appendHandle: key => directory.appendHandle(key),
    markerHandle: key => directory.markerHandle(key),
    syncDirectoryOf: key => directory.syncDirectoryOf(key),
    read: key => directory.read(key),
    remove: key => directory.remove(key),
    list: prefix => directory.list(prefix),
    async atomicWrite(key, data) {
      if (key.includes(failOnKeySubstring)) {
        throw new Error(`simulated crash writing "${key}"`)
      }
      return directory.atomicWrite(key, data)
    },
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

describe('segmented checkpoint crash safety', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-segcrash-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('keeps the prior checkpoint recoverable when the manifest write fails', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 30; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    const firstManifestBytes = await createDurableDirectory(root).read('docs/manifest')
    expect(firstManifestBytes).not.toBeNull()
    if (firstManifestBytes === null) {
      return
    }
    const firstManifest = await decodeSegmentManifest(firstManifestBytes)

    for (let i = 30; i < 45; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.shutdown()

    const metadata = await loadMetadata(createDurableDirectory(root), 'docs')
    if (metadata === null) {
      throw new Error('metadata missing')
    }
    const lastSeqNo = await highestDurableSeqNo(root, 'docs')
    const faulty = injectAtomicWriteFault(createDurableDirectory(root), '/manifest')

    await expect(rebuildIntoFaulty(faulty, metadata, lastSeqNo)).rejects.toThrow(/simulated crash/)

    const directory = createDurableDirectory(root)
    const manifestBytes = await directory.read('docs/manifest')
    expect(manifestBytes).not.toBeNull()
    if (manifestBytes === null) {
      return
    }
    const manifestAfter = await decodeSegmentManifest(manifestBytes)
    expect(manifestAfter.checkpoint[0].lastSeqNo).toBe(firstManifest.checkpoint[0].lastSeqNo)

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(45)
    expect(await reader.get('docs', 'd44')).toMatchObject({ title: 'Document 44' })
    await reader.shutdown()
  })

  it('preserves the prior segment set when an incremental checkpoint fails on the manifest write', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 30; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    const firstManifestBytes = await createDurableDirectory(root).read('docs/manifest')
    if (firstManifestBytes === null) {
      throw new Error('first manifest missing')
    }
    const firstManifest = await decodeSegmentManifest(firstManifestBytes)
    const firstSegmentKeys = firstManifest.partitions[0].segments.map(s => s.key)

    for (let i = 30; i < 90; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.shutdown()

    const metadata = await loadMetadata(createDurableDirectory(root), 'docs')
    if (metadata === null) {
      throw new Error('metadata missing')
    }
    const lastSeqNo = await highestDurableSeqNo(root, 'docs')
    const faulty = injectAtomicWriteFault(createDurableDirectory(root), '/manifest')

    const { writeSegmentedCheckpoint } = await import('../../../persistence/durability/segment')
    await expect(
      writeSegmentedCheckpoint({
        directory: faulty,
        metadata,
        targets: [{ partitionId: 0, lastSeqNo, primaryTerm: SINGLE_NODE_PRIMARY_TERM }],
        compactionThreshold: 12,
      }),
    ).rejects.toThrow(/simulated crash/)

    const manifestAfterBytes = await createDurableDirectory(root).read('docs/manifest')
    if (manifestAfterBytes === null) {
      throw new Error('manifest missing after crash')
    }
    const manifestAfter = await decodeSegmentManifest(manifestAfterBytes)
    expect(manifestAfter.partitions[0].segments.map(s => s.key)).toEqual(firstSegmentKeys)
    expect(manifestAfter.checkpoint[0].lastSeqNo).toBe(firstManifest.checkpoint[0].lastSeqNo)

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(90)
    expect(await reader.get('docs', 'd0')).toMatchObject({ title: 'Document 0' })
    expect(await reader.get('docs', 'd89')).toMatchObject({ title: 'Document 89' })
    await reader.shutdown()
  }, 30_000)
})

async function rebuildIntoFaulty(
  faulty: DurableDirectory,
  metadata: Awaited<ReturnType<typeof loadMetadata>>,
  lastSeqNo: number,
): Promise<void> {
  if (metadata === null) {
    throw new Error('metadata missing')
  }
  const { writeSegmentedCheckpoint } = await import('../../../persistence/durability/segment')
  await writeSegmentedCheckpoint({
    directory: faulty,
    metadata,
    targets: [{ partitionId: 0, lastSeqNo, primaryTerm: SINGLE_NODE_PRIMARY_TERM }],
    compactionThreshold: 12,
  })
}
