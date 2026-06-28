import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { loadMetadata } from '../../../persistence/durability/recovery'
import { readSegmentManifest, writeSegmentedCheckpoint } from '../../../persistence/durability/segment'
import { decodeSegmentManifest, type SegmentManifest } from '../../../persistence/durability/segment/manifest'
import { type MergeFallback, mergeTimeOrderedSegments } from '../../../persistence/durability/segment/merge'
import { encodeSegmentFile, type SegmentContents } from '../../../persistence/durability/segment/segment-file'
import { SINGLE_NODE_PRIMARY_TERM } from '../../../persistence/durability/seq-owner'
import { packSnapshotEnvelopeParts } from '../../../serialization/envelope'
import type { SerializablePartition } from '../../../types/internal'
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

function fallback(): MergeFallback {
  return { indexName: 'docs', partitionId: 0, totalPartitions: 1, language: 'english' }
}

function segmentOf(entries: Array<{ docId: string; token: string }>, tombstones: string[] = []): SegmentContents {
  const partition: SerializablePartition = {
    indexName: 'docs',
    partitionId: 0,
    totalPartitions: 1,
    language: 'english',
    schema: { body: 'string' },
    docCount: 0,
    avgDocLength: 0,
    documents: Object.create(null),
    invertedIndex: Object.create(null),
    fieldIndexes: {
      numeric: Object.create(null),
      boolean: Object.create(null),
      enum: Object.create(null),
      geopoint: Object.create(null),
    },
    statistics: {
      totalDocuments: 0,
      totalFieldLengths: Object.create(null),
      averageFieldLengths: Object.create(null),
      docFrequencies: Object.create(null),
    },
  }
  for (const { docId, token } of entries) {
    partition.documents[docId] = { fields: { body: token }, fieldLengths: { body: 1 } }
    let list = partition.invertedIndex[token]
    if (list === undefined) {
      list = { docFrequency: 0, postings: [] }
      partition.invertedIndex[token] = list
    }
    list.postings.push({ docId, termFrequency: 1, field: 'body', positions: [0] })
    list.docFrequency = list.postings.length
  }
  return { partition, tombstones }
}

describe('segment durability hardening', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-seghard-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('carries forward partitions a later checkpoint does not cover and keeps their segments', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 20; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const baseManifestBytes = await directory.read('docs/manifest')
    if (baseManifestBytes === null) {
      throw new Error('base manifest missing')
    }
    const baseManifest = await decodeSegmentManifest(baseManifestBytes)

    const plantedKey = 'docs/segments/1/s0000000000000000'
    const plantedParts = await encodeSegmentFile(new Uint8Array([1, 2, 3, 4]), [])
    await directory.atomicWrite(plantedKey, [plantedParts.header, plantedParts.payload])

    const augmented: SegmentManifest = {
      ...baseManifest,
      checkpoint: [...baseManifest.checkpoint, { partitionId: 1, lastSeqNo: 5, primaryTerm: SINGLE_NODE_PRIMARY_TERM }],
      partitions: [
        ...baseManifest.partitions,
        {
          partitionId: 1,
          nextSegmentId: 1,
          segments: [{ id: 0, key: plantedKey, docCount: 1, tombstoneCount: 0 }],
          vectors: [],
        },
      ],
    }
    const { encodeSegmentManifest } = await import('../../../persistence/durability/segment/manifest')
    const augmentedParts = await encodeSegmentManifest(augmented)
    await directory.atomicWrite('docs/manifest', [augmentedParts.header, augmentedParts.payload])

    const metadata = await loadMetadata(directory, 'docs')
    if (metadata === null) {
      throw new Error('metadata missing')
    }

    await writeSegmentedCheckpoint({
      directory,
      metadata,
      targets: [{ partitionId: 0, lastSeqNo: 20, primaryTerm: SINGLE_NODE_PRIMARY_TERM }],
      compactionThreshold: 12,
    })

    const finalManifest = await readSegmentManifest(directory, 'docs')
    if (finalManifest === null) {
      throw new Error('final manifest missing')
    }
    const partitionOne = finalManifest.partitions.find(p => p.partitionId === 1)
    expect(partitionOne).toBeDefined()
    expect(partitionOne?.segments[0]?.key).toBe(plantedKey)
    expect(finalManifest.checkpoint.find(c => c.partitionId === 1)?.lastSeqNo).toBe(5)
    expect(await directory.read(plantedKey)).not.toBeNull()
  })

  it('reclaims an orphaned segment during recovery without losing referenced data', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 20; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const orphanKey = 'docs/segments/0/s0000000000009999'
    const orphanBytes = await packSnapshotEnvelopeParts(new Uint8Array([9, 9, 9]))
    await directory.atomicWrite(orphanKey, [orphanBytes.header, orphanBytes.payload])
    expect(await directory.read(orphanKey)).not.toBeNull()

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(20)
    const result = await reader.query('docs', { term: 'quick brown fox' })
    expect(result.hits.length).toBeGreaterThan(0)
    await reader.shutdown()

    expect(await directory.read(orphanKey)).toBeNull()
  })

  it('lets the newest segment win when a document is updated across segments', () => {
    const older = segmentOf([{ docId: 'd1', token: 'stale' }])
    const newer = segmentOf([{ docId: 'd1', token: 'fresh' }])
    const merged = mergeTimeOrderedSegments([older, newer], fallback())
    expect(Object.keys(merged.documents)).toEqual(['d1'])
    expect(merged.documents.d1.fields.body).toBe('fresh')
    expect(merged.invertedIndex.fresh?.postings.length).toBe(1)
    expect(merged.invertedIndex.stale).toBeUndefined()
    expect(merged.statistics.totalDocuments).toBe(1)
  })

  it('drops a document tombstoned by a later segment', () => {
    const older = segmentOf([
      { docId: 'd1', token: 'fox' },
      { docId: 'd2', token: 'dog' },
    ])
    const newer = segmentOf([], ['d2'])
    const merged = mergeTimeOrderedSegments([older, newer], fallback())
    expect(Object.keys(merged.documents)).toEqual(['d1'])
    expect(merged.invertedIndex.dog).toBeUndefined()
    expect(merged.invertedIndex.fox?.docFrequency).toBe(1)
    expect(merged.statistics.totalDocuments).toBe(1)
  })
})
