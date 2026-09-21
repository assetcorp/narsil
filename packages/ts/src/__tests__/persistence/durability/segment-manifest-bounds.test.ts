import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { getLanguage } from '../../../languages/registry'
import { createPartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { loadSegmentedSnapshot } from '../../../persistence/durability/segment/load'
import {
  decodeSegmentManifest,
  MAX_SEGMENTS_PER_PARTITION,
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
  it('rejects an unsupported manifest version', async () => {
    const bytes = await encodeRawManifest({
      version: 2,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [],
      partitions: [],
    })
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(/Unsupported segment manifest version/)
  })

  it('accepts a well-formed manifest', async () => {
    const bytes = await encodeRawManifest({
      version: SEGMENT_MANIFEST_VERSION,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [{ partitionId: 0, lastSeqNo: 7, primaryTerm: 1 }],
      partitions: [
        {
          partitionId: 0,
          nextSegmentId: 2,
          segments: [{ id: 1, key: 'docs/segments/0/s0000000000000001', docCount: 5, tombstoneCount: 0 }],
        },
      ],
    })
    const manifest = await decodeSegmentManifest(bytes)
    expect(manifest.partitions[0].segments[0].id).toBe(1)
    expect(manifest.partitions[0].nextSegmentId).toBe(2)
  })

  const embedding = {
    fieldPath: 'embedding',
    nextFileId: 5,
    files: [
      { id: 2, key: 'docs/segments/vec-embedding-1l4nfg2-f0000000000000002', count: 9, dead: Uint8Array.of(4, 1) },
      { id: 4, key: 'docs/segments/vec-embedding-1l4nfg2-f0000000000000004', count: 3, dead: null },
    ],
    graphGeneration: 3,
    graphKey: 'docs/segments/vec-embedding-1l4nfg2-graph-g3',
  }

  function manifestWithVectors(vectors: unknown[]): Promise<Uint8Array> {
    return encodeRawManifest({
      version: SEGMENT_MANIFEST_VERSION,
      schema: { title: 'string', embedding: 'vector[8]' },
      language: 'english',
      checkpoint: [],
      partitions: [],
      vectors,
    })
  }

  it('reads the vector files and the graph file of each field from the manifest itself', async () => {
    const bytes = await manifestWithVectors([embedding])
    expect((await decodeSegmentManifest(bytes)).vectors).toEqual([embedding])
  })

  it('reads a field with no vector file and no graph', async () => {
    const empty = { fieldPath: 'embedding', nextFileId: 0, files: [], graphGeneration: 0, graphKey: null }
    expect((await decodeSegmentManifest(await manifestWithVectors([empty]))).vectors).toEqual([empty])
  })

  it('rejects a manifest that lists one vector field twice', async () => {
    const bytes = await manifestWithVectors([embedding, { ...embedding, graphGeneration: 4 }])
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(/lists the vector field "embedding" twice/)
  })

  it('rejects dead marks of any length but one bit per vector', async () => {
    const files = [{ ...embedding.files[0], dead: Uint8Array.of(4) }]
    const bytes = await manifestWithVectors([{ ...embedding, files }])
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(/wrong number of bytes/)
  })

  it('rejects a graph file named at generation 0, which no writer reaches', async () => {
    const bytes = await manifestWithVectors([{ ...embedding, graphGeneration: 0 }])
    await expect(decodeSegmentManifest(bytes)).rejects.toMatchObject({ code: ErrorCodes.PERSISTENCE_LOAD_FAILED })
  })

  it('rejects a vector file that counts more than 65,536 vectors', async () => {
    const files = [{ ...embedding.files[1], count: 65_537 }]
    const bytes = await manifestWithVectors([{ ...embedding, files }])
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(/invalid count/)
  })

  it('rejects a vector file listed twice and a file at the next file id', async () => {
    const twice = await manifestWithVectors([{ ...embedding, files: [embedding.files[0], embedding.files[0]] }])
    const atNext = await manifestWithVectors([{ ...embedding, nextFileId: 4 }])
    await expect(decodeSegmentManifest(twice)).rejects.toThrow(/twice or at its next file id/)
    await expect(decodeSegmentManifest(atNext)).rejects.toThrow(/twice or at its next file id/)
  })

  it('rejects a segment list above the maximum', async () => {
    const segments = []
    for (let i = 0; i <= MAX_SEGMENTS_PER_PARTITION; i += 1) {
      segments.push({ id: i, key: `docs/segments/0/s${i}`, docCount: 1, tombstoneCount: 0 })
    }
    const bytes = await encodeRawManifest({
      version: SEGMENT_MANIFEST_VERSION,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [],
      partitions: [{ partitionId: 0, nextSegmentId: segments.length, segments }],
    })
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(/exceeding the maximum/)
  })

  it('rejects a manifest that reuses a segment id', async () => {
    const bytes = await encodeRawManifest({
      version: SEGMENT_MANIFEST_VERSION,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [],
      partitions: [
        {
          partitionId: 0,
          nextSegmentId: 2,
          segments: [
            { id: 1, key: 'docs/segments/0/s-a', docCount: 1, tombstoneCount: 0 },
            { id: 1, key: 'docs/segments/0/s-b', docCount: 1, tombstoneCount: 0 },
          ],
        },
      ],
    })
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(/reuses segment id/)
  })

  it('rejects a next segment id that does not exceed an existing segment id', async () => {
    const bytes = await encodeRawManifest({
      version: SEGMENT_MANIFEST_VERSION,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [],
      partitions: [
        {
          partitionId: 0,
          nextSegmentId: 1,
          segments: [{ id: 1, key: 'docs/segments/0/s1', docCount: 1, tombstoneCount: 0 }],
        },
      ],
    })
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(/does not exceed an existing segment id/)
  })

  it('rejects a segment reference with a negative document count', async () => {
    const bytes = await encodeRawManifest({
      version: SEGMENT_MANIFEST_VERSION,
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [],
      partitions: [
        {
          partitionId: 0,
          nextSegmentId: 1,
          segments: [{ id: 0, key: 'docs/segments/0/s0', docCount: -1, tombstoneCount: 0 }],
        },
      ],
    })
    await expect(decodeSegmentManifest(bytes)).rejects.toThrow(NarsilError)
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
      schema: { title: 'string' },
      language: 'english',
      checkpoint: [],
      partitions: [
        { partitionId: 0, nextSegmentId: 0, segments: [] },
        { partitionId: 1, nextSegmentId: 0, segments: [] },
      ],
      vectors: [],
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
