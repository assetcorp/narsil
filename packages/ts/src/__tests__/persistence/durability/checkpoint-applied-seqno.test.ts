import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { createDurabilityManager } from '../../../persistence/durability/manager'
import { decodeSnapshotBundle } from '../../../persistence/durability/snapshot-bundle'
import type { IndexDurabilityHooks } from '../../../persistence/durability/types'

interface FakeManager {
  partitionCount: number
  serializePartitionToBytes(partitionId: number): Uint8Array
}

function makeHooks(serialize: () => Uint8Array): IndexDurabilityHooks {
  const fakeManager: FakeManager = {
    partitionCount: 1,
    serializePartitionToBytes: () => serialize(),
  }
  return {
    getManager: () => fakeManager as never,
    getVectorFieldPaths: () => new Set(),
    getVectorIndexes: () => new Map(),
    buildMetadata: () => ({
      indexName: 'docs',
      schema: { title: 'string' },
      language: 'english',
      partitionCount: 1,
      bm25Params: { k1: 1.2, b: 0.75 },
      createdAt: 0,
      engineVersion: '0.0.0',
    }),
    createIndexFromMetadata: async () => undefined,
    onFatalError: () => undefined,
  }
}

describe('checkpoint records the applied sequence number', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-applied-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('records only the confirmed-applied seqNo, never an allocated-but-unapplied one', async () => {
    const directory = createDurableDirectory(root)
    const manager = createDurabilityManager(
      { directory: root, mode: 'sync', checkpointIntervalMs: 0 },
      makeHooks(() => new Uint8Array([1])),
      directory,
    )

    const first = await manager.recordMutation({
      indexName: 'docs',
      partitionId: 0,
      operation: 'INDEX',
      documentId: 'd1',
      document: new Uint8Array([1]),
    })
    manager.markApplied('docs', 0, first)

    await manager.recordMutation({
      indexName: 'docs',
      partitionId: 0,
      operation: 'INDEX',
      documentId: 'd2',
      document: new Uint8Array([2]),
    })

    await manager.checkpoint('docs')

    const snapshot = await directory.read('docs/snapshot')
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return
    const bundle = await decodeSnapshotBundle(snapshot)
    expect(bundle.checkpoint[0].lastSeqNo).toBe(first)

    await manager.shutdown()
  })
})
