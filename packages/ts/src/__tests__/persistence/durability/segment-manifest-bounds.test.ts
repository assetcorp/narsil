import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { getLanguage } from '../../../languages/registry'
import { createPartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { loadSegmentedCheckpoint } from '../../../persistence/durability/segment/load'
import { MAX_SEGMENTS_PER_PARTITION, type SegmentManifest } from '../../../persistence/durability/segment/manifest'
import { decodeSegmentManifest } from '../../../persistence/durability/segment/manifest-decode'
import { directoryCheckpointStore } from '../../../persistence/durability/segment/store'
import type { IndexConfig } from '../../../types/schema'
import { sealEnvelope } from '../../e2e/portability/archive-oracle'

const MANIFEST_ENVELOPE_VERSION = 2
const VECTOR_KEY_STEM = 'docs/segments/vec-embedding-1l4nfg2'

function manifestBytes(payload: Record<string, unknown>): Uint8Array {
  return sealEnvelope(MANIFEST_ENVELOPE_VERSION, encode(payload))
}

function segmentKey(id: number): string {
  return `docs/segments/0/s${String(id).padStart(16, '0')}`
}

function segment(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, key: segmentKey(id), docCount: 5, tombstoneCount: 0, bytes: 512, checksum: 7, ...overrides }
}

function manifestWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 7,
    schema: { title: 'string', embedding: 'vector[8]' },
    language: 'english',
    checkpoint: [{ partitionId: 0, lastSeqNo: 7, primaryTerm: 1 }],
    partitions: [{ partitionId: 0, nextSegmentId: 2, segments: [segment(1)] }],
    vectors: [],
    ...overrides,
  }
}

const embedding = {
  fieldPath: 'embedding',
  nextFileId: 5,
  files: [
    {
      id: 2,
      key: `${VECTOR_KEY_STEM}-f0000000000000002`,
      count: 9,
      dead: Uint8Array.of(4, 1),
      bytes: 900,
      checksum: 11,
    },
    { id: 4, key: `${VECTOR_KEY_STEM}-f0000000000000004`, count: 3, dead: null, bytes: 300, checksum: 12 },
  ],
  graphGeneration: 3,
  graphParts: [
    { key: `${VECTOR_KEY_STEM}-graph-g3-p0000000000000000`, bytes: 400, checksum: 13 },
    { key: `${VECTOR_KEY_STEM}-graph-g3-p0000000000000001`, bytes: 100, checksum: 14 },
  ],
}

async function refusalOf(payload: Record<string, unknown>): Promise<NarsilError> {
  try {
    await decodeSegmentManifest(manifestBytes(payload), 'docs')
  } catch (error) {
    if (error instanceof NarsilError) return error
    throw error
  }
  throw new Error('the reader accepted the manifest')
}

async function currentManifestOf(payload: Record<string, unknown>): Promise<SegmentManifest> {
  const decoded = await decodeSegmentManifest(manifestBytes(payload), 'docs')
  if (decoded.kind !== 'current') throw new Error('the reader took the manifest for an earlier layout')
  return decoded.manifest
}

describe('segment manifest decode bounds', () => {
  it('accepts a well-formed manifest with its file lengths and checksums', async () => {
    const manifest = await currentManifestOf(manifestWith({ vectors: [embedding] }))

    expect(manifest.partitions[0].segments[0]).toEqual({
      id: 1,
      key: segmentKey(1),
      docCount: 5,
      tombstoneCount: 0,
      bytes: 512,
      checksum: 7,
    })
    expect(manifest.partitions[0].nextSegmentId).toBe(2)
    expect(manifest.vectors).toEqual([embedding])
  })

  it('hands a layout 6 manifest to the upgrade and refuses every other layout', async () => {
    const earlier = await decodeSegmentManifest(manifestBytes(manifestWith({ version: 6 })), 'docs')
    expect(earlier.kind).toBe('earlier')

    for (const version of [2, 5, 8, 'seven']) {
      const refusal = await refusalOf(manifestWith({ version }))
      expect(refusal.code).toBe(ErrorCodes.ENVELOPE_VERSION_MISMATCH)
      expect(refusal.message).toMatch(/export/i)
    }
  })

  it('refuses a manifest whose envelope is not version 2', async () => {
    const bytes = sealEnvelope(1, encode(manifestWith()))

    await expect(decodeSegmentManifest(bytes, 'docs')).rejects.toMatchObject({
      code: ErrorCodes.ENVELOPE_VERSION_MISMATCH,
    })
  })

  it('refuses a listed key that the path convention does not build for the entry', async () => {
    const wrongSegment = manifestWith({
      partitions: [{ partitionId: 0, nextSegmentId: 2, segments: [segment(1, { key: '../../etc/passwd' })] }],
    })
    const wrongPartition = manifestWith({
      partitions: [
        { partitionId: 0, nextSegmentId: 2, segments: [segment(1, { key: 'docs/segments/1/s0000000000000001' })] },
      ],
    })
    const wrongIndex = manifestWith({
      partitions: [
        { partitionId: 0, nextSegmentId: 2, segments: [segment(1, { key: 'other/segments/0/s0000000000000001' })] },
      ],
    })
    const wrongGraphPart = manifestWith({
      vectors: [{ ...embedding, graphParts: [embedding.graphParts[1], embedding.graphParts[0]] }],
    })
    const wrongVectorFile = manifestWith({
      vectors: [{ ...embedding, files: [{ ...embedding.files[0], key: embedding.files[1].key }] }],
    })

    for (const payload of [wrongSegment, wrongPartition, wrongIndex, wrongGraphPart, wrongVectorFile]) {
      expect((await refusalOf(payload)).code).toBe(ErrorCodes.PERSISTENCE_LOAD_FAILED)
    }
  })

  it('refuses a file length below the header, above the file size limit, or missing, and a checksum outside uint32', async () => {
    for (const overrides of [
      { bytes: 31 },
      { bytes: 2_147_483_648 },
      { bytes: undefined },
      { bytes: 1.5 },
      { checksum: -1 },
      { checksum: 2 ** 32 },
      { checksum: undefined },
    ]) {
      const payload = manifestWith({
        partitions: [{ partitionId: 0, nextSegmentId: 2, segments: [segment(1, overrides)] }],
      })
      expect((await refusalOf(payload)).code).toBe(ErrorCodes.PERSISTENCE_LOAD_FAILED)
    }
  })

  it('reads a field with no vector file and no graph', async () => {
    const empty = { fieldPath: 'embedding', nextFileId: 0, files: [], graphGeneration: 0, graphParts: [] }

    expect((await currentManifestOf(manifestWith({ vectors: [empty] }))).vectors).toEqual([empty])
  })

  it('refuses a vector field listed twice, graph parts at generation 0, and a field with no list of parts', async () => {
    const { graphParts: _parts, ...withoutParts } = embedding
    for (const vectors of [
      [embedding, { ...embedding, graphGeneration: 4 }],
      [{ ...embedding, graphGeneration: 0 }],
      [withoutParts],
    ]) {
      expect((await refusalOf(manifestWith({ vectors }))).code).toBe(ErrorCodes.PERSISTENCE_LOAD_FAILED)
    }
  })

  it('refuses dead marks of any length but one bit per vector, and a vector file above 65,536 vectors', async () => {
    const shortDead = [{ ...embedding.files[0], dead: Uint8Array.of(4) }]
    const tooMany = [{ ...embedding.files[1], count: 65_537 }]

    expect((await refusalOf(manifestWith({ vectors: [{ ...embedding, files: shortDead }] }))).message).toMatch(
      /wrong number of bytes/,
    )
    expect((await refusalOf(manifestWith({ vectors: [{ ...embedding, files: tooMany }] }))).message).toMatch(
      /invalid count/,
    )
  })

  it('refuses a vector file listed twice and a file at the next file id', async () => {
    const twice = manifestWith({ vectors: [{ ...embedding, files: [embedding.files[0], embedding.files[0]] }] })
    const atNext = manifestWith({ vectors: [{ ...embedding, nextFileId: 4 }] })

    expect((await refusalOf(twice)).message).toMatch(/twice or at its next file id/)
    expect((await refusalOf(atNext)).message).toMatch(/twice or at its next file id/)
  })

  it('refuses a segment list above the maximum', async () => {
    const segments = []
    for (let i = 0; i <= MAX_SEGMENTS_PER_PARTITION; i += 1) segments.push(segment(i))
    const payload = manifestWith({ partitions: [{ partitionId: 0, nextSegmentId: segments.length, segments }] })

    expect((await refusalOf(payload)).code).toBe(ErrorCodes.PERSISTENCE_LOAD_FAILED)
  })

  it('refuses a reused segment id, a next segment id at or below an existing id, and a negative count', async () => {
    for (const partitions of [
      [{ partitionId: 0, nextSegmentId: 2, segments: [segment(1), segment(1)] }],
      [{ partitionId: 0, nextSegmentId: 1, segments: [segment(1)] }],
      [{ partitionId: 0, nextSegmentId: 2, segments: [segment(1, { docCount: -1 })] }],
      [
        { partitionId: 0, nextSegmentId: 2, segments: [segment(1)] },
        { partitionId: 0, nextSegmentId: 2, segments: [] },
      ],
    ]) {
      expect((await refusalOf(manifestWith({ partitions }))).code).toBe(ErrorCodes.PERSISTENCE_LOAD_FAILED)
    }
  })

  it('refuses a payload that is not a map and a schema that names an unknown type', async () => {
    const notAMap = sealEnvelope(MANIFEST_ENVELOPE_VERSION, encode(['version', 7]))

    await expect(decodeSegmentManifest(notAMap, 'docs')).rejects.toMatchObject({
      code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
    })
    expect((await refusalOf(manifestWith({ schema: { title: 'glob' } }))).code).toBe(ErrorCodes.SCHEMA_INVALID_TYPE)
  })
})

describe('segment load partition bounds', () => {
  it('refuses a manifest partition id beyond the partition cap', async () => {
    const config: IndexConfig = {
      schema: { title: 'string' },
      language: 'english',
      partitions: { maxPartitions: 1 },
    }
    const manager = createPartitionManager(
      'docs',
      config,
      getLanguage('english'),
      createPartitionRouter(),
      1,
      new Map(),
    )
    const manifest = await currentManifestOf(
      manifestWith({
        schema: { title: 'string' },
        partitions: [
          { partitionId: 0, nextSegmentId: 0, segments: [] },
          { partitionId: 1, nextSegmentId: 0, segments: [] },
        ],
      }),
    )

    const store = directoryCheckpointStore(createDurableDirectory('/tmp/narsil-bounds-unused'))
    await expect(
      loadSegmentedCheckpoint(store, 'docs', manifest, { manager, vectorIndexes: new Map() }),
    ).rejects.toMatchObject({ code: ErrorCodes.PERSISTENCE_LOAD_FAILED })
  })
})
