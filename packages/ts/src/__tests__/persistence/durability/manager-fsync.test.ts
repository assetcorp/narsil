import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NarsilError } from '../../../errors'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { createDurabilityManager } from '../../../persistence/durability/manager'
import type { IndexDurabilityHooks } from '../../../persistence/durability/types'

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

describe('durability manager fsync handling', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-mgr-fsync-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('rejects a mutation when the WAL fsync fails and does not acknowledge it', async () => {
    const directory = createDurableDirectory(root)
    const originalAppendHandle = directory.appendHandle.bind(directory)
    vi.spyOn(directory, 'appendHandle').mockImplementation(async key => {
      const handle = await originalAppendHandle(key)
      return {
        ...handle,
        sync: async () => {
          throw new NarsilError('PERSISTENCE_FSYNC_FAILED', 'injected fsync failure')
        },
      }
    })

    const manager = createDurabilityManager({ directory: root, mode: 'sync' }, inertHooks(), directory)

    await expect(
      manager.recordMutation({
        indexName: 'movies',
        partitionId: 0,
        operation: 'INDEX',
        documentId: 'm1',
        document: new Uint8Array([1]),
        apply: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_FSYNC_FAILED' })

    await manager.shutdown()
  })
})
