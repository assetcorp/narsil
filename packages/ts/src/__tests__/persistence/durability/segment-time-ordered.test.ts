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
    body: `the quick brown fox number ${i} jumps over the lazy dog and runs far`,
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

async function segmentFiles(root: string, indexName: string, partitionId: number): Promise<string[]> {
  const directory = createDurableDirectory(root)
  const keys = await directory.list(`${indexName}/segments/${partitionId}/`)
  return keys.filter(key => key.includes('/s')).sort()
}

describe('time-ordered segmented checkpoint', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-segtime-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes a single segment on a cold checkpoint', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 40; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    const manifest = await readManifest(root, 'docs')
    await writer.shutdown()

    expect(manifest.partitions[0].segments.length).toBe(1)
    expect(manifest.partitions[0].segments[0].docCount).toBe(40)
    expect(manifest.partitions[0].nextSegmentId).toBe(1)
  })

  it('appends one new segment per incremental checkpoint and never rewrites prior segment files', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 30; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    const firstFiles = await segmentFiles(root, 'docs', 0)
    const firstManifest = await readManifest(root, 'docs')
    expect(firstFiles.length).toBe(1)

    await writer.insert('docs', doc(100), 'd100')
    await writer.checkpoint('docs')
    const secondManifest = await readManifest(root, 'docs')
    const secondFiles = await segmentFiles(root, 'docs', 0)
    await writer.shutdown()

    expect(secondManifest.partitions[0].segments.length).toBe(2)
    const firstKeys = firstManifest.partitions[0].segments.map(s => s.key)
    const carriedForward = secondManifest.partitions[0].segments.filter(s => firstKeys.includes(s.key))
    expect(carriedForward.length).toBe(1)
    for (const file of firstFiles) {
      expect(secondFiles).toContain(file)
    }
  })

  it('reuses every segment file verbatim across a no-op checkpoint', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 20; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    const first = await segmentFiles(root, 'docs', 0)

    await writer.checkpoint('docs')
    const second = await segmentFiles(root, 'docs', 0)
    await writer.shutdown()

    expect(second).toEqual(first)
  })

  it('produces no segment for an empty index', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    await writer.checkpoint('docs')
    const manifest = await readManifest(root, 'docs')
    await writer.shutdown()

    expect(manifest.partitions[0].segments.length).toBe(0)
    expect((await segmentFiles(root, 'docs', 0)).length).toBe(0)
  })

  it('resolves updates and deletes across segments so the newest write wins on recovery', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 50; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    await writer.remove('docs', 'd0')
    await writer.update('docs', 'd1', { title: 'Updated 1', body: 'rewritten body text', year: 1999 })
    await writer.insert('docs', doc(200), 'd200')
    await writer.checkpoint('docs')
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(50)
    expect(await reader.has('docs', 'd0')).toBe(false)
    expect(await reader.get('docs', 'd1')).toMatchObject({ title: 'Updated 1', year: 1999 })
    expect(await reader.get('docs', 'd200')).toMatchObject({ title: 'Document 200' })
    const rewritten = await reader.query('docs', { term: 'rewritten body' })
    expect(rewritten.hits.some(hit => hit.id === 'd1')).toBe(true)
    const stale = await reader.query('docs', { term: 'brown fox lazy dog' })
    expect(stale.hits.length).toBeGreaterThan(0)
    expect(stale.hits.some(hit => hit.id === 'd1')).toBe(false)
    await reader.shutdown()
  })

  it('records a tombstone-only segment when a checkpoint sees only deletes', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 10; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    await writer.remove('docs', 'd3')
    await writer.checkpoint('docs')
    const manifest = await readManifest(root, 'docs')
    expect(manifest.partitions[0].segments.length).toBe(2)
    const tombstoneSegment = manifest.partitions[0].segments[1]
    expect(tombstoneSegment.docCount).toBe(0)
    expect(tombstoneSegment.tombstoneCount).toBe(1)
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(9)
    expect(await reader.has('docs', 'd3')).toBe(false)
    await reader.shutdown()
  })

  it('bounds the segment count through compaction while preserving every document', async () => {
    const writer = await createNarsil({ durability: { directory: root, compactionThreshold: 3 } })
    await writer.createIndex('docs', SCHEMA)
    for (let batch = 0; batch < 10; batch += 1) {
      for (let i = 0; i < 5; i += 1) {
        const id = batch * 5 + i
        await writer.insert('docs', doc(id), `d${id}`)
      }
      await writer.checkpoint('docs')
    }
    const manifest = await readManifest(root, 'docs')
    await writer.shutdown()

    expect(manifest.partitions[0].segments.length).toBeLessThanOrEqual(3)

    const reader = await createNarsil({ durability: { directory: root, compactionThreshold: 3 } })
    expect(await reader.countDocuments('docs')).toBe(50)
    expect(await reader.get('docs', 'd0')).toMatchObject({ title: 'Document 0' })
    expect(await reader.get('docs', 'd49')).toMatchObject({ title: 'Document 49' })
    const result = await reader.query('docs', { term: 'quick brown fox' })
    expect(result.hits.length).toBeGreaterThan(0)
    await reader.shutdown()
  })

  it('keeps deletes durable across compaction', async () => {
    const writer = await createNarsil({ durability: { directory: root, compactionThreshold: 2 } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 20; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    for (let i = 0; i < 10; i += 1) {
      await writer.remove('docs', `d${i}`)
      await writer.checkpoint('docs')
    }
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root, compactionThreshold: 2 } })
    expect(await reader.countDocuments('docs')).toBe(10)
    for (let i = 0; i < 10; i += 1) {
      expect(await reader.has('docs', `d${i}`)).toBe(false)
    }
    for (let i = 10; i < 20; i += 1) {
      expect(await reader.has('docs', `d${i}`)).toBe(true)
    }
    await reader.shutdown()
  })
})
