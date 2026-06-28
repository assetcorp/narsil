import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reconstructSchemaFromMetadata } from '../../../engine/recovery-schema'
import { getLanguage } from '../../../languages/registry'
import { createNarsil } from '../../../narsil'
import { createPartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import { writeSnapshotFile } from '../../../persistence/durability/checkpoint'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { loadMetadata, loadSnapshot } from '../../../persistence/durability/recovery'
import { decodeSegmentManifest } from '../../../persistence/durability/segment/manifest'
import { packSnapshotEnvelopeParts } from '../../../serialization/envelope'
import type { IndexConfig } from '../../../types/schema'

const SCHEMA: IndexConfig = {
  schema: { title: 'string', body: 'string', year: 'number' },
  language: 'english',
}

function doc(i: number): { title: string; body: string; year: number } {
  return {
    title: `Document ${i}`,
    body: `the quick brown fox number ${i} jumps over the lazy dog and runs`,
    year: 2000 + (i % 30),
  }
}

async function rewriteAsLegacyMonolithicSnapshot(root: string, indexName: string): Promise<void> {
  const directory = createDurableDirectory(root)
  const metadata = await loadMetadata(directory, indexName)
  if (metadata === null) {
    throw new Error('metadata missing')
  }
  const config = reconstructSchemaFromMetadata(metadata)
  const language = getLanguage(config.language ?? 'english')
  const router = createPartitionRouter()
  const manager = createPartitionManager(indexName, config, language, router, 1, new Map())
  const checkpoint = await loadSnapshot(directory, indexName, {
    manager,
    vectorFieldPaths: new Set(),
    vectorIndexes: new Map(),
  })

  const seqNoByPartition = new Map<number, number>()
  const primaryTermByPartition = new Map<number, number>()
  for (const entry of checkpoint) {
    seqNoByPartition.set(entry.partitionId, entry.lastSeqNo)
    primaryTermByPartition.set(entry.partitionId, entry.primaryTerm)
  }

  await writeSnapshotFile(directory, {
    indexName,
    schema: metadata.schema,
    language: metadata.language,
    manager,
    vectorIndexes: new Map(),
    seqNoByPartition,
    primaryTermByPartition,
  })

  await directory.remove(`${indexName}/manifest`)
  for (const key of await directory.list(`${indexName}/segments/`)) {
    await directory.remove(key)
  }
}

describe('segmented snapshot recovery', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-segrec-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('recovers from a legacy single-file snapshot when no manifest exists', async () => {
    const writer = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 25; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    for (let i = 25; i < 30; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.shutdown()

    await rewriteAsLegacyMonolithicSnapshot(root, 'docs')
    const directory = createDurableDirectory(root)
    expect(await directory.read('docs/manifest')).toBeNull()
    expect(await directory.read('docs/snapshot')).not.toBeNull()

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(30)
    expect(await reader.get('docs', 'd0')).toMatchObject({ title: 'Document 0' })
    expect(await reader.get('docs', 'd29')).toMatchObject({ title: 'Document 29' })
    await reader.shutdown()
  })

  it('recovers from a version-1 fixed-count manifest by migrating it to directory routing', async () => {
    const writer = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 40; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const currentBytes = await directory.read('docs/manifest')
    if (currentBytes === null) {
      throw new Error('manifest missing')
    }
    const current = await decodeSegmentManifest(currentBytes)

    const legacyPayload = {
      version: 1,
      bucketCount: current.initialBucketCount,
      schema: current.schema,
      language: current.language,
      checkpoint: current.checkpoint.map(c => ({
        partitionId: c.partitionId,
        lastSeqNo: c.lastSeqNo,
        primaryTerm: c.primaryTerm,
      })),
      partitions: current.partitions.map(p => ({
        partitionId: p.partitionId,
        buckets: p.buckets.map(b => ({ bucketId: b.bucketId, generation: b.generation, key: b.key })),
        vectors: p.vectors.map(v => ({ fieldPath: v.fieldPath, generation: v.generation, key: v.key })),
      })),
    }
    const parts = await packSnapshotEnvelopeParts(encode(legacyPayload))
    await directory.atomicWrite('docs/manifest', [parts.header, parts.payload])

    const reader = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    expect(await reader.countDocuments('docs')).toBe(40)
    expect(await reader.get('docs', 'd0')).toMatchObject({ title: 'Document 0' })
    expect(await reader.get('docs', 'd39')).toMatchObject({ title: 'Document 39' })
    const result = await reader.query('docs', { term: 'quick brown fox' })
    expect(result.hits.length).toBeGreaterThan(0)
    await reader.shutdown()
  })

  it('reproduces BM25 ranking identical to a fresh monolithic build', async () => {
    const durable = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    await durable.createIndex('docs', SCHEMA)
    for (let i = 0; i < 60; i += 1) {
      await durable.insert('docs', doc(i), `d${i}`)
    }
    await durable.checkpoint('docs')
    await durable.insert('docs', doc(60), 'd60')
    await durable.checkpoint('docs')
    await durable.shutdown()

    const recovered = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    const recoveredResult = await recovered.query('docs', { term: 'quick brown fox', limit: 100 })
    await recovered.shutdown()

    const fresh = await createNarsil()
    await fresh.createIndex('docs', SCHEMA)
    for (let i = 0; i <= 60; i += 1) {
      await fresh.insert('docs', doc(i), `d${i}`)
    }
    const freshResult = await fresh.query('docs', { term: 'quick brown fox', limit: 100 })
    await fresh.shutdown()

    expect(recoveredResult.hits.length).toBe(freshResult.hits.length)

    const recoveredScores = new Map(recoveredResult.hits.map(hit => [hit.id, hit.score]))
    for (const hit of freshResult.hits) {
      const recoveredScore = recoveredScores.get(hit.id)
      expect(recoveredScore).toBeDefined()
      if (recoveredScore !== undefined) {
        expect(recoveredScore).toBeCloseTo(hit.score, 10)
      }
    }

    const recoveredScoreSequence = recoveredResult.hits.map(hit => hit.score)
    const freshScoreSequence = freshResult.hits.map(hit => hit.score)
    for (let i = 0; i < freshScoreSequence.length; i += 1) {
      expect(recoveredScoreSequence[i]).toBeCloseTo(freshScoreSequence[i], 10)
    }
  })

  it('restores vectors from per-field segments and keeps vector search working', async () => {
    const vectorSchema: IndexConfig = {
      schema: { title: 'string', embedding: 'vector[4]' },
      language: 'english',
    }
    const writer = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    await writer.createIndex('docs', vectorSchema)
    await writer.insert('docs', { title: 'near', embedding: [1, 0, 0, 0] }, 'near')
    await writer.insert('docs', { title: 'mid', embedding: [0.5, 0.5, 0, 0] }, 'mid')
    await writer.checkpoint('docs')
    await writer.insert('docs', { title: 'far', embedding: [0, 0, 0, 1] }, 'far')
    await writer.checkpoint('docs')
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    expect(await reader.countDocuments('docs')).toBe(3)
    const result = await reader.query('docs', {
      vector: { field: 'embedding', value: [1, 0, 0, 0], metric: 'cosine' },
      limit: 2,
    })
    expect(result.hits).toHaveLength(2)
    expect(result.hits[0].id).toBe('near')
    await reader.shutdown()
  })
})
