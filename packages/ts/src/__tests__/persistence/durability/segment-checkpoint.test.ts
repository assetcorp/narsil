import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { decodeSegmentManifest } from '../../../persistence/durability/segment/manifest'
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

async function readManifest(root: string, indexName: string) {
  const directory = createDurableDirectory(root)
  const bytes = await directory.read(`${indexName}/manifest`)
  if (bytes === null) {
    throw new Error('manifest missing')
  }
  return decodeSegmentManifest(bytes)
}

describe('segmented checkpoint', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-segment-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('rewrites only the buckets touched since the last checkpoint', async () => {
    const writer = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 40; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    const first = await readManifest(root, 'docs')

    await writer.insert('docs', doc(100), 'd100')
    await writer.checkpoint('docs')
    const second = await readManifest(root, 'docs')
    await writer.shutdown()

    const firstByBucket = new Map(first.partitions[0].buckets.map(b => [b.bucketId, b]))
    let changed = 0
    let reused = 0
    for (const bucket of second.partitions[0].buckets) {
      const prior = firstByBucket.get(bucket.bucketId)
      if (prior !== undefined && prior.key === bucket.key) {
        reused += 1
      } else {
        changed += 1
      }
    }
    expect(changed).toBe(1)
    expect(reused).toBeGreaterThan(0)
  })

  it('reuses unchanged bucket files verbatim across a no-op checkpoint', async () => {
    const writer = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 30; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    const first = await readManifest(root, 'docs')

    await writer.checkpoint('docs')
    const second = await readManifest(root, 'docs')
    await writer.shutdown()

    const firstKeys = first.partitions[0].buckets.map(b => b.key).sort()
    const secondKeys = second.partitions[0].buckets.map(b => b.key).sort()
    expect(secondKeys).toEqual(firstKeys)
  })

  it('produces no bucket file for an empty index', async () => {
    const writer = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    await writer.createIndex('docs', SCHEMA)
    await writer.checkpoint('docs')
    const manifest = await readManifest(root, 'docs')
    await writer.shutdown()

    expect(manifest.partitions[0].buckets.length).toBe(0)
    const directory = createDurableDirectory(root)
    expect((await directory.list('docs/segments/')).length).toBe(0)
  })

  it('recovers the full document set and keeps search working', async () => {
    const writer = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 50; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    await writer.remove('docs', 'd0')
    await writer.insert('docs', doc(200), 'd200')
    await writer.checkpoint('docs')
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    expect(await reader.countDocuments('docs')).toBe(50)
    expect(await reader.has('docs', 'd0')).toBe(false)
    expect(await reader.get('docs', 'd200')).toMatchObject({ title: 'Document 200' })
    const result = await reader.query('docs', { term: 'quick brown fox' })
    expect(result.hits.length).toBeGreaterThan(0)
    await reader.shutdown()
  })

  it('uses the initial bucket count recorded in the manifest, ignoring a later config change', async () => {
    const writer = await createNarsil({ durability: { directory: root, bucketCount: 8 } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 20; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    await writer.shutdown()

    const reopened = await createNarsil({ durability: { directory: root, bucketCount: 64 } })
    await reopened.insert('docs', doc(21), 'd21')
    await reopened.checkpoint('docs')
    const manifest = await readManifest(root, 'docs')
    await reopened.shutdown()

    expect(manifest.initialBucketCount).toBe(8)
  })
})
