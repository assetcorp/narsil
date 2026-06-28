import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { NarsilError } from '../../../errors'
import { getLanguage } from '../../../languages/registry'
import { createPartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { loadSegmentedSnapshot } from '../../../persistence/durability/segment/load'
import {
  decodeSegmentManifest,
  MAX_BUCKET_COUNT,
  SEGMENT_MANIFEST_VERSION,
  type SegmentManifest,
} from '../../../persistence/durability/segment/manifest'
import { packSnapshotEnvelopeParts } from '../../../serialization/envelope'
import type { IndexConfig } from '../../../types/schema'

async function encodeRawManifest(payload: Record<string, unknown>): Promise<Uint8Array> {
  const parts = await packSnapshotEnvelopeParts(encode(payload))
  const combined = new Uint8Array(parts.header.length + parts.payload.length)
  combined.set(parts.header, 0)
  combined.set(parts.payload, parts.header.length)
  return combined
}

describe('segment manifest decode bounds', () => {
  it('rejects an initial bucket count above the maximum', async () => {
    const bytes = await encodeRawManifest({
      version: SEGMENT_MANIFEST_VERSION,
      initialBucketCount: MAX_BUCKET_COUNT + 1,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [],
      partitions: [{ partitionId: 0, globalDepth: 0, directory: [0], buckets: [], vectors: [] }],
    })
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(NarsilError)
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(/initial bucket count/)
  })

  it('accepts an initial bucket count at the maximum', async () => {
    const bytes = await encodeRawManifest({
      version: SEGMENT_MANIFEST_VERSION,
      initialBucketCount: MAX_BUCKET_COUNT,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [],
      partitions: [{ partitionId: 0, globalDepth: 0, directory: [0], buckets: [], vectors: [] }],
    })
    const manifest = await decodeSegmentManifest(bytes)
    expect(manifest.initialBucketCount).toBe(MAX_BUCKET_COUNT)
  })

  it('rejects a global depth above the supported maximum without allocating', async () => {
    const bytes = await encodeRawManifest({
      version: SEGMENT_MANIFEST_VERSION,
      initialBucketCount: 4,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [],
      partitions: [{ partitionId: 0, globalDepth: 30, directory: [], buckets: [], vectors: [] }],
    })
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(/global depth/)
  })

  it('rejects a directory whose size does not match the global depth', async () => {
    const bytes = await encodeRawManifest({
      version: SEGMENT_MANIFEST_VERSION,
      initialBucketCount: 4,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [],
      partitions: [{ partitionId: 0, globalDepth: 2, directory: [0, 1], buckets: [], vectors: [] }],
    })
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(/directory size/)
  })

  it('migrates a version-1 fixed-count manifest to directory routing', async () => {
    const bytes = await encodeRawManifest({
      version: 1,
      bucketCount: 4,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [{ partitionId: 0, lastSeqNo: 7, primaryTerm: 1 }],
      partitions: [
        {
          partitionId: 0,
          buckets: [{ bucketId: 1, generation: 3, key: 'docs/segments/0/b1-g3' }],
          vectors: [],
        },
      ],
    })
    const manifest = await decodeSegmentManifest(bytes)
    expect(manifest.version).toBe(SEGMENT_MANIFEST_VERSION)
    expect(manifest.initialBucketCount).toBe(4)
    expect(manifest.partitions[0].globalDepth).toBe(2)
    expect(manifest.partitions[0].directory).toEqual([0, 1, 2, 3])
    expect(manifest.partitions[0].buckets[0]).toEqual({
      bucketId: 1,
      localDepth: 2,
      generation: 3,
      key: 'docs/segments/0/b1-g3',
    })
  })

  it('rejects a directory slot that references an out-of-range bucket id', async () => {
    const bytes = await encodeRawManifest({
      version: SEGMENT_MANIFEST_VERSION,
      initialBucketCount: 4,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [],
      partitions: [{ partitionId: 0, globalDepth: 1, directory: [0, 5], buckets: [], vectors: [] }],
    })
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(NarsilError)
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(/dense range/)
  })

  it('accepts a directory whose slots reference an empty bucket absent from the bucket list', async () => {
    const bytes = await encodeRawManifest({
      version: SEGMENT_MANIFEST_VERSION,
      initialBucketCount: 4,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [],
      partitions: [{ partitionId: 0, globalDepth: 1, directory: [0, 1], buckets: [], vectors: [] }],
    })
    const manifest = await decodeSegmentManifest(bytes)
    expect(manifest.partitions[0].directory).toEqual([0, 1])
    expect(manifest.partitions[0].buckets).toEqual([])
  })

  it('rejects a bucket segment that no directory slot references', async () => {
    const bytes = await encodeRawManifest({
      version: SEGMENT_MANIFEST_VERSION,
      initialBucketCount: 4,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [],
      partitions: [
        {
          partitionId: 0,
          globalDepth: 1,
          directory: [0, 1],
          buckets: [{ bucketId: 2, localDepth: 1, generation: 1, key: 'docs/segments/0/b2-g1' }],
          vectors: [],
        },
      ],
    })
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(NarsilError)
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(/no directory slot references/)
  })

  it('rejects a version-1 manifest with a non-power-of-two bucket count', async () => {
    const bytes = await encodeRawManifest({
      version: 1,
      bucketCount: 6,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [],
      partitions: [{ partitionId: 0, buckets: [], vectors: [] }],
    })
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(/not a power of two/)
  })
})

describe('segment load partition bounds', () => {
  it('rejects a manifest partition id beyond the partition cap', async () => {
    const config: IndexConfig = {
      schema: { title: 'string' },
      language: 'english',
      partitions: { maxPartitions: 1 },
    }
    const language = getLanguage('english')
    const router = createPartitionRouter()
    const manager = createPartitionManager('docs', config, language, router, 1, new Map())

    const manifest: SegmentManifest = {
      version: SEGMENT_MANIFEST_VERSION,
      initialBucketCount: 8,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [],
      partitions: [
        { partitionId: 0, globalDepth: 0, directory: [0], buckets: [], vectors: [] },
        { partitionId: 1, globalDepth: 0, directory: [0], buckets: [], vectors: [] },
      ],
    }

    const directory = createDurableDirectory('/tmp/narsil-bounds-unused')
    await expect(
      loadSegmentedSnapshot(directory, 'docs', manifest, {
        manager,
        vectorFieldPaths: new Set(),
        vectorIndexes: new Map(),
      }),
    ).rejects.toThrow(/beyond the partition count/)
  })
})
