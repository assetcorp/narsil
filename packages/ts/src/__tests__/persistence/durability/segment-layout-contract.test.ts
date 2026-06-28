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
    const writer = await createNarsil({ durability: { directory: root, bucketCount: 4 } })
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
    expect(manifest.version).toBe(2)
    expect(manifest.initialBucketCount).toBe(4)
    expect(manifest.schema).toEqual({ title: 'string', year: 'number' })
    expect(manifest.language).toBe('english')
    expect(manifest.checkpoint).toEqual([{ partitionId: 0, lastSeqNo: 12, primaryTerm: 1 }])
    expect(manifest.partitions.length).toBe(1)
    expect(manifest.partitions[0].partitionId).toBe(0)
    expect(manifest.partitions[0].globalDepth).toBe(2)
    expect(manifest.partitions[0].directory).toEqual([0, 1, 2, 3])
    expect(manifest.partitions[0].vectors).toEqual([])

    for (const bucket of manifest.partitions[0].buckets) {
      expect(bucket.key).toMatch(/^docs\/segments\/0\/b\d+-g\d+$/)
      expect(bucket.bucketId).toBeGreaterThanOrEqual(0)
      expect(bucket.bucketId).toBeLessThan(4)
      expect(bucket.localDepth).toBe(2)
      expect(bucket.generation).toBe(1)

      const segmentBytes = await directory.read(bucket.key)
      if (segmentBytes === null) {
        throw new Error(`segment ${bucket.key} missing`)
      }
      expect(segmentBytes[4]).toBe(2)
      const { payloadBytes } = await unpackEnvelopeBytes(segmentBytes)
      const partition = deserializePayloadV2(payloadBytes)
      expect(partition.schema).toEqual({ title: 'string', year: 'number' })
      expect(Object.keys(partition.documents).length).toBeGreaterThan(0)
    }
  })
})
