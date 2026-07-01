import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { decodeSegmentManifest } from '../../../persistence/durability/segment/manifest'
import { decodeSegmentFile } from '../../../persistence/durability/segment/segment-file'
import type { IndexConfig } from '../../../types/schema'

const SCHEMA: IndexConfig = {
  schema: { title: 'string', year: 'number' },
  language: 'english',
}

describe('segment on-disk layout contract', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-seglayout-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('pins the manifest and segment key layout', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 12; i += 1) {
      await writer.insert('docs', { title: `Title ${i}`, year: 2000 + i }, `d${i}`)
    }
    await writer.checkpoint('docs')
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const manifestBytes = await directory.read('docs/manifest')
    if (manifestBytes === null) {
      throw new Error('manifest missing')
    }

    expect(manifestBytes[4]).toBe(2)

    const manifest = await decodeSegmentManifest(manifestBytes)
    expect(manifest.version).toBe(3)
    expect(manifest.schema).toEqual({ title: 'string', year: 'number' })
    expect(manifest.language).toBe('english')
    expect(manifest.checkpoint).toEqual([{ partitionId: 0, lastSeqNo: 12, primaryTerm: 1 }])
    expect(manifest.partitions.length).toBe(1)
    expect(manifest.partitions[0].partitionId).toBe(0)
    expect(manifest.partitions[0].nextSegmentId).toBe(1)
    expect(manifest.partitions[0].vectors).toEqual([])
    expect(manifest.partitions[0].segments.length).toBe(1)

    const segment = manifest.partitions[0].segments[0]
    expect(segment.id).toBe(0)
    expect(segment.key).toMatch(/^docs\/segments\/0\/s\d{16}$/)
    expect(segment.docCount).toBe(12)
    expect(segment.tombstoneCount).toBe(0)

    const segmentBytes = await directory.read(segment.key)
    if (segmentBytes === null) {
      throw new Error(`segment ${segment.key} missing`)
    }
    expect(segmentBytes[4]).toBe(2)
    const contents = await decodeSegmentFile(segmentBytes)
    expect(contents.tombstones).toEqual([])
    expect(contents.partition.schema).toEqual({ title: 'string', year: 'number' })
    expect(Object.keys(contents.partition.documents).length).toBe(12)
  })
})
