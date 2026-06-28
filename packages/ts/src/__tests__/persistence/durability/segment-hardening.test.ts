import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reconstructSchemaFromMetadata } from '../../../engine/recovery-schema'
import { NarsilError } from '../../../errors'
import { getLanguage } from '../../../languages/registry'
import { createNarsil } from '../../../narsil'
import { createPartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { loadMetadata } from '../../../persistence/durability/recovery'
import { readSegmentManifest, writeSegmentedCheckpoint } from '../../../persistence/durability/segment'
import { decodeSegmentManifest, type SegmentManifest } from '../../../persistence/durability/segment/manifest'
import { mergeBucketPartitions } from '../../../persistence/durability/segment/merge'
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

function fallback(): { indexName: string; partitionId: number; totalPartitions: number; language: string } {
  return { indexName: 'docs', partitionId: 0, totalPartitions: 1, language: 'english' }
}

function emptyPartition(documents: SerializablePartition['documents']): SerializablePartition {
  return {
    indexName: 'docs',
    partitionId: 0,
    totalPartitions: 1,
    language: 'english',
    schema: {},
    docCount: 0,
    avgDocLength: 0,
    documents,
    invertedIndex: {},
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
    const writer = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
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

    const plantedKey = 'docs/segments/1/b0-g1'
    const plantedBytes = await packSnapshotEnvelopeParts(new Uint8Array([1, 2, 3, 4]))
    await directory.atomicWrite(plantedKey, [plantedBytes.header, plantedBytes.payload])

    const augmented: SegmentManifest = {
      ...baseManifest,
      checkpoint: [...baseManifest.checkpoint, { partitionId: 1, lastSeqNo: 5, primaryTerm: SINGLE_NODE_PRIMARY_TERM }],
      partitions: [
        ...baseManifest.partitions,
        {
          partitionId: 1,
          globalDepth: 0,
          directory: [0],
          buckets: [{ bucketId: 0, localDepth: 0, generation: 1, key: plantedKey }],
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
      initialBucketCount: 8,
      targetBucketBytes: 65_536,
    })

    const finalManifest = await readSegmentManifest(directory, 'docs')
    if (finalManifest === null) {
      throw new Error('final manifest missing')
    }
    const partitionOne = finalManifest.partitions.find(p => p.partitionId === 1)
    expect(partitionOne).toBeDefined()
    expect(partitionOne?.buckets[0]?.key).toBe(plantedKey)
    expect(finalManifest.checkpoint.find(c => c.partitionId === 1)?.lastSeqNo).toBe(5)
    expect(await directory.read(plantedKey)).not.toBeNull()
  })

  it('reclaims an orphaned segment during recovery without losing referenced data', async () => {
    const writer = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 20; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const orphanKey = 'docs/segments/0/b0-g999'
    const orphanBytes = await packSnapshotEnvelopeParts(new Uint8Array([9, 9, 9]))
    await directory.atomicWrite(orphanKey, [orphanBytes.header, orphanBytes.payload])
    expect(await directory.read(orphanKey)).not.toBeNull()

    const reader = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    expect(await reader.countDocuments('docs')).toBe(20)
    const result = await reader.query('docs', { term: 'quick brown fox' })
    expect(result.hits.length).toBeGreaterThan(0)
    await reader.shutdown()

    expect(await directory.read(orphanKey)).toBeNull()
  })

  it('accepts a correctly built merged segment set', async () => {
    const writer = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 12; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const metadata = await loadMetadata(directory, 'docs')
    if (metadata === null) {
      throw new Error('metadata missing')
    }
    const config = reconstructSchemaFromMetadata(metadata)
    const language = getLanguage(config.language ?? 'english')
    const router = createPartitionRouter()
    const manager = createPartitionManager('docs', config, language, router, 1, new Map())

    const manifest = await readSegmentManifest(directory, 'docs')
    if (manifest === null) {
      throw new Error('manifest missing')
    }
    const decoded: SerializablePartition[] = []
    for (const bucket of manifest.partitions[0].buckets) {
      const bytes = await directory.read(bucket.key)
      if (bytes === null) {
        throw new Error('bucket missing')
      }
      const { payloadBytes } = await import('../../../serialization/envelope').then(m => m.unpackEnvelopeBytes(bytes))
      const { deserializePayloadV2 } = await import('../../../serialization/payload-v2')
      decoded.push(deserializePayloadV2(payloadBytes))
    }
    expect(() => mergeBucketPartitions(decoded, fallback())).not.toThrow()
    expect(manager.partitionCount).toBe(1)
  })

  it('rejects a merged segment set whose postings reference a missing document', () => {
    const part = emptyPartition(Object.create(null))
    part.invertedIndex = {
      fox: {
        docFrequency: 1,
        postings: [{ docId: 'ghost', termFrequency: 1, field: 'body', positions: [0] }],
      },
    }
    part.statistics.totalDocuments = 0
    expect(() => mergeBucketPartitions([part], fallback())).toThrow(NarsilError)
  })

  it('rejects a merged segment set whose docFrequency disagrees with distinct postings', () => {
    const documents: SerializablePartition['documents'] = Object.create(null)
    documents.d0 = { fields: { body: 'fox' }, fieldLengths: { body: 1 } }
    const part = emptyPartition(documents)
    part.invertedIndex = {
      fox: {
        docFrequency: 5,
        postings: [{ docId: 'd0', termFrequency: 1, field: 'body', positions: [0] }],
      },
    }
    part.statistics.totalDocuments = 1
    expect(() => mergeBucketPartitions([part], fallback())).toThrow(/docFrequency/)
  })
})
