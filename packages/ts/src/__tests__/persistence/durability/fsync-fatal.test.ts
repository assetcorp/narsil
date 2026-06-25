import { describe, expect, it } from 'vitest'
import { buildEntry } from '../../../distribution/replication/entry-checksum'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { NarsilError } from '../../../errors'
import type { AppendHandle, DurableDirectory, MarkerHandle } from '../../../persistence/durability/durable-filesystem'
import { createWalWriter } from '../../../persistence/durability/wal-writer'

function entry(seqNo: number): ReplicationLogEntry {
  return buildEntry({
    seqNo,
    primaryTerm: 1,
    operation: 'INDEX',
    partitionId: 0,
    indexName: 'movies',
    documentId: `doc-${seqNo}`,
    document: new Uint8Array([1]),
  })
}

function failingSyncDirectory(): { directory: DurableDirectory; appended: Uint8Array[] } {
  const appended: Uint8Array[] = []
  const handle: AppendHandle = {
    async append(bytes: Uint8Array): Promise<void> {
      appended.push(bytes)
    },
    async sync(): Promise<void> {
      throw new NarsilError('PERSISTENCE_FSYNC_FAILED', 'fsync returned EIO')
    },
    async truncate(): Promise<void> {
      return undefined
    },
    async size(): Promise<number> {
      return appended.reduce((sum, b) => sum + b.length, 0)
    },
    async close(): Promise<void> {
      return undefined
    },
  }

  const marker: MarkerHandle = {
    async read(): Promise<Uint8Array> {
      return new Uint8Array(0)
    },
    async writeSlot(): Promise<void> {
      return undefined
    },
    async close(): Promise<void> {
      return undefined
    },
  }

  const directory: DurableDirectory = {
    root: '/fake',
    async appendHandle(): Promise<AppendHandle> {
      return handle
    },
    async markerHandle(): Promise<MarkerHandle> {
      return marker
    },
    async atomicWrite(): Promise<void> {
      return undefined
    },
    async syncDirectoryOf(): Promise<void> {
      return undefined
    },
    async read(): Promise<Uint8Array | null> {
      return null
    },
    async remove(): Promise<void> {
      return undefined
    },
    async list(): Promise<string[]> {
      return []
    },
  }

  return { directory, appended }
}

describe('fsync failure is fatal', () => {
  it('surfaces PERSISTENCE_FSYNC_FAILED and does not silently swallow the error', async () => {
    const { directory } = failingSyncDirectory()
    const writer = createWalWriter(directory, { indexName: 'movies', partitionId: 0 })

    await expect(writer.appendDurable(entry(1))).rejects.toMatchObject({ code: 'PERSISTENCE_FSYNC_FAILED' })
  })

  it('rejects every durable append while fsync keeps failing', async () => {
    const { directory } = failingSyncDirectory()
    const writer = createWalWriter(directory, { indexName: 'movies', partitionId: 0 })

    await expect(writer.appendDurable(entry(1))).rejects.toBeInstanceOf(NarsilError)
    await expect(writer.commit()).rejects.toBeInstanceOf(NarsilError)
  })
})
