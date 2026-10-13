import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { readCommitMarker } from '../../../persistence/durability/commit-marker'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import type { IndexConfig } from '../../../types/schema'
import { requireManifestOnDisk } from './manifest-on-disk'

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

    const manifest = await requireManifestOnDisk(directory, 'docs')
    expect(manifest.checkpoint[0].lastSeqNo).toBe(marker.state.highestDurableSeqNo)
    expect(manifest.checkpoint[0].lastSeqNo).toBe(2)
  })
})
