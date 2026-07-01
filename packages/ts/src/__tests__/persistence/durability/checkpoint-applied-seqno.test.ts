import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { readCommitMarker } from '../../../persistence/durability/commit-marker'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { decodeSegmentManifest } from '../../../persistence/durability/segment/manifest'
import type { IndexConfig } from '../../../types/schema'

const SCHEMA: IndexConfig = {
  schema: { title: 'string' },
  language: 'english',
}

describe('checkpoint records the applied sequence number', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-applied-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('records the head of the writes that applied before the checkpoint', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    await writer.insert('docs', { title: 'first' }, 'd1')
    await writer.insert('docs', { title: 'second' }, 'd2')
    await writer.checkpoint('docs')
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const markerBytes = await directory.read('docs/wal/0/commit')
    if (markerBytes === null) {
      throw new Error('commit marker missing')
    }
    const marker = readCommitMarker(markerBytes)
    if (marker === null) {
      throw new Error('commit marker unreadable')
    }

    const manifestBytes = await directory.read('docs/manifest')
    if (manifestBytes === null) {
      throw new Error('manifest missing')
    }
    const manifest = await decodeSegmentManifest(manifestBytes)
    expect(manifest.checkpoint[0].lastSeqNo).toBe(marker.state.highestDurableSeqNo)
    expect(manifest.checkpoint[0].lastSeqNo).toBe(2)
  })
})
