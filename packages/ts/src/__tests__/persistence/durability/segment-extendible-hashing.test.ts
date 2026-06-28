import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { decodeSegmentManifest } from '../../../persistence/durability/segment/manifest'
import { unpackEnvelopeBytes } from '../../../serialization/envelope'
import { deserializePayloadV2 } from '../../../serialization/payload-v2'
import type { IndexConfig } from '../../../types/schema'

const SCHEMA: IndexConfig = {
  schema: { title: 'string', body: 'string', year: 'number' },
  language: 'english',
}

function doc(i: number): { title: string; body: string; year: number } {
  return {
    title: `Document ${i}`,
    body: `the quick brown fox number ${i} jumps over the lazy dog and runs far`,
    year: 2000 + (i % 30),
  }
}

function wideDoc(i: number): { title: string; body: string; year: number } {
  const filler: string[] = []
  for (let token = 0; token < 80; token += 1) {
    filler.push(`term${i}x${token}`)
  }
  return {
    title: `Document ${i}`,
    body: `the quick brown fox number ${i} jumps over the lazy dog ${filler.join(' ')}`,
    year: 2000 + (i % 30),
  }
}

async function readManifest(root: string, indexName: string) {
  const directory = createDurableDirectory(root)
  const bytes = await directory.read(`${indexName}/manifest`)
  if (bytes === null) {
    throw new Error('manifest missing')
  }
  return decodeSegmentManifest(bytes)
}

async function docIdsInBucket(root: string, key: string): Promise<string[]> {
  const directory = createDurableDirectory(root)
  const bytes = await directory.read(key)
  if (bytes === null) {
    throw new Error(`segment ${key} missing`)
  }
  const { payloadBytes } = await unpackEnvelopeBytes(bytes)
  const partition = deserializePayloadV2(payloadBytes)
  return Object.keys(partition.documents)
}

describe('extendible-hashing checkpoint routing', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-exthash-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('starts small and grows the bucket set only as data exceeds the per-bucket target', async () => {
    const writer = await createNarsil({
      durability: { directory: root, bucketCount: 1, targetBucketBytes: 1024 },
    })
    await writer.createIndex('docs', SCHEMA)
    await writer.insert('docs', doc(0), 'd0')
    await writer.checkpoint('docs')
    const initial = await readManifest(root, 'docs')
    expect(initial.partitions[0].globalDepth).toBe(0)

    for (let i = 1; i < 80; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    const grown = await readManifest(root, 'docs')
    await writer.shutdown()

    expect(grown.partitions[0].globalDepth).toBeGreaterThan(0)
    expect(grown.partitions[0].buckets.length).toBeGreaterThan(1)
    const maxLocalDepth = Math.max(...grown.partitions[0].buckets.map(b => b.localDepth))
    expect(maxLocalDepth).toBeGreaterThan(0)
  }, 30_000)

  it('keeps documents disjoint across bucket files after a split', async () => {
    const writer = await createNarsil({
      durability: { directory: root, bucketCount: 1, targetBucketBytes: 1024 },
    })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 120; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    const manifest = await readManifest(root, 'docs')
    await writer.shutdown()

    const seen = new Set<string>()
    let total = 0
    for (const bucket of manifest.partitions[0].buckets) {
      for (const docId of await docIdsInBucket(root, bucket.key)) {
        expect(seen.has(docId)).toBe(false)
        seen.add(docId)
        total += 1
      }
    }
    expect(total).toBe(120)
    expect(seen.size).toBe(120)
  }, 30_000)

  it('recovers every document and keeps search working after the bucket set grows', async () => {
    const writer = await createNarsil({
      durability: { directory: root, bucketCount: 1, targetBucketBytes: 1024 },
    })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 150; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    await writer.shutdown()

    const reader = await createNarsil({
      durability: { directory: root, bucketCount: 1, targetBucketBytes: 1024 },
    })
    expect(await reader.countDocuments('docs')).toBe(150)
    expect(await reader.get('docs', 'd0')).toMatchObject({ title: 'Document 0' })
    expect(await reader.get('docs', 'd149')).toMatchObject({ title: 'Document 149' })
    const result = await reader.query('docs', { term: 'quick brown fox' })
    expect(result.hits.length).toBeGreaterThan(0)
    await reader.shutdown()
  }, 30_000)

  it('starts a fresh index at a single bucket under the default and grows as data exceeds the target', async () => {
    const documentCount = 200
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    await writer.insert('docs', wideDoc(0), 'd0')
    await writer.checkpoint('docs')
    const initial = await readManifest(root, 'docs')
    expect(initial.partitions[0].globalDepth).toBe(0)
    expect(initial.partitions[0].buckets.length).toBe(1)

    for (let i = 1; i < documentCount; i += 1) {
      await writer.insert('docs', wideDoc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    const grown = await readManifest(root, 'docs')
    await writer.shutdown()

    expect(grown.partitions[0].globalDepth).toBeGreaterThan(0)
    expect(grown.partitions[0].buckets.length).toBeGreaterThan(1)

    const seen = new Set<string>()
    for (const bucket of grown.partitions[0].buckets) {
      for (const docId of await docIdsInBucket(root, bucket.key)) {
        expect(seen.has(docId)).toBe(false)
        seen.add(docId)
      }
    }
    expect(seen.size).toBe(documentCount)

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(documentCount)
    expect(await reader.get('docs', 'd0')).toMatchObject({ title: 'Document 0' })
    expect(await reader.get('docs', `d${documentCount - 1}`)).toMatchObject({
      title: `Document ${documentCount - 1}`,
    })
    const result = await reader.query('docs', { term: 'quick brown fox' })
    expect(result.hits.length).toBeGreaterThan(0)
    await reader.shutdown()
  }, 30_000)

  it('routes an incremental change to a grown bucket set without duplicating or dropping documents', async () => {
    const writer = await createNarsil({
      durability: { directory: root, bucketCount: 1, targetBucketBytes: 1024 },
    })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 100; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    await writer.remove('docs', 'd0')
    await writer.insert('docs', doc(500), 'd500')
    await writer.insert('docs', doc(501), 'd501')
    await writer.checkpoint('docs')
    const manifest = await readManifest(root, 'docs')
    await writer.shutdown()

    const seen = new Set<string>()
    for (const bucket of manifest.partitions[0].buckets) {
      for (const docId of await docIdsInBucket(root, bucket.key)) {
        expect(seen.has(docId)).toBe(false)
        seen.add(docId)
      }
    }
    expect(seen.has('d0')).toBe(false)
    expect(seen.has('d500')).toBe(true)
    expect(seen.size).toBe(101)

    const reader = await createNarsil({
      durability: { directory: root, bucketCount: 1, targetBucketBytes: 1024 },
    })
    expect(await reader.countDocuments('docs')).toBe(101)
    expect(await reader.has('docs', 'd0')).toBe(false)
    expect(await reader.get('docs', 'd501')).toMatchObject({ title: 'Document 501' })
    await reader.shutdown()
  }, 30_000)

  it('fans a large first checkpoint directly to many buckets and recovers the disjoint document set', async () => {
    const documentCount = 1500
    const writer = await createNarsil({
      durability: { directory: root, targetBucketBytes: 4096 },
    })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < documentCount; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    const manifest = await readManifest(root, 'docs')
    await writer.shutdown()

    expect(manifest.partitions[0].globalDepth).toBeGreaterThan(2)
    expect(manifest.partitions[0].buckets.length).toBeGreaterThan(8)
    const maxLocalDepth = Math.max(...manifest.partitions[0].buckets.map(b => b.localDepth))
    expect(maxLocalDepth).toBe(manifest.partitions[0].globalDepth)

    const seen = new Set<string>()
    let total = 0
    for (const bucket of manifest.partitions[0].buckets) {
      for (const docId of await docIdsInBucket(root, bucket.key)) {
        expect(seen.has(docId)).toBe(false)
        seen.add(docId)
        total += 1
      }
    }
    expect(total).toBe(documentCount)

    const reader = await createNarsil({ durability: { directory: root, targetBucketBytes: 4096 } })
    expect(await reader.countDocuments('docs')).toBe(documentCount)
    expect(await reader.get('docs', 'd0')).toMatchObject({ title: 'Document 0' })
    expect(await reader.get('docs', `d${documentCount - 1}`)).toMatchObject({
      title: `Document ${documentCount - 1}`,
    })
    const result = await reader.query('docs', { term: 'quick brown fox' })
    expect(result.hits.length).toBeGreaterThan(0)
    await reader.shutdown()
  }, 30_000)
})
