import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NarsilError } from '../../../errors'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { createDurabilityManager } from '../../../persistence/durability/manager'
import type { IndexDurabilityHooks, MutationRecord } from '../../../persistence/durability/types'

function inertHooks(): IndexDurabilityHooks {
  return {
    getManager: () => undefined,
    getVectorFieldPaths: () => new Set(),
    getVectorIndexes: () => new Map(),
    buildMetadata: () => undefined,
    createIndexFromMetadata: async () => undefined,
    onFatalError: () => undefined,
  }
}

function mutation(indexName: string, documentId: string, apply: () => Promise<void>): MutationRecord {
  return { indexName, partitionId: 0, operation: 'INDEX', documentId, document: new Uint8Array([1]), apply }
}

describe('durability fatal latch and group commit', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-fatal-latch-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('halts acknowledgment on a healthy index after a fatal durability error elsewhere', async () => {
    const directory = createDurableDirectory(root)
    const realAppendHandle = directory.appendHandle.bind(directory)
    let failSync = true
    vi.spyOn(directory, 'appendHandle').mockImplementation(async key => {
      const handle = await realAppendHandle(key)
      return {
        ...handle,
        sync: async () => {
          if (failSync) {
            throw new NarsilError('PERSISTENCE_FSYNC_FAILED', 'injected fsync failure')
          }
          await handle.sync()
        },
      }
    })

    const manager = createDurabilityManager(
      { directory: root, mode: 'sync', checkpointIntervalMs: 0 },
      inertHooks(),
      directory,
    )

    await expect(manager.recordMutation(mutation('movies', 'm1', async () => undefined))).rejects.toMatchObject({
      code: 'PERSISTENCE_FSYNC_FAILED',
    })

    failSync = false
    const apply = vi.fn(async () => undefined)
    await expect(manager.recordMutation(mutation('books', 'b1', apply))).rejects.toBeInstanceOf(NarsilError)
    expect(apply).not.toHaveBeenCalled()

    await manager.shutdown()
  })

  it('shares a single fsync across concurrent writes instead of one per write', async () => {
    const directory = createDurableDirectory(root)
    const realAppendHandle = directory.appendHandle.bind(directory)
    let syncCount = 0
    vi.spyOn(directory, 'appendHandle').mockImplementation(async key => {
      const handle = await realAppendHandle(key)
      return {
        ...handle,
        sync: async () => {
          syncCount += 1
          await handle.sync()
        },
      }
    })

    const manager = createDurabilityManager(
      { directory: root, mode: 'sync', checkpointIntervalMs: 0 },
      inertHooks(),
      directory,
    )

    const writeCount = 24
    const writes = Array.from({ length: writeCount }, (_, i) =>
      manager.recordMutation(mutation('movies', `m${i}`, async () => undefined)),
    )
    await Promise.all(writes)

    expect(syncCount).toBeLessThan(writeCount)

    await manager.shutdown()
  })
})
