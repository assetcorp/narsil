import { encode } from '@msgpack/msgpack'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dropExistingIndex } from '../../../distribution/cluster-node/bootstrap-restore'
import {
  type BootstrapSyncDeps,
  clearBootstrapSyncIndex,
  createBootstrapSyncState,
  runBootstrapSync,
} from '../../../distribution/cluster-node/bootstrap-sync'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { SNAPSHOT_CHUNK_SIZE } from '../../../distribution/replication/snapshot-constants'
import type {
  NodeTransport,
  ReplicationSnapshotHeader,
  SnapshotChunkPayload,
  SnapshotEndPayload,
  SnapshotStartPayload,
} from '../../../distribution/transport/types'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { Narsil } from '../../../narsil'
import { crc32 } from '../../../serialization/crc32'

interface MockEngineHandle {
  engine: Narsil
  restoreCalls: Array<{ indexName: string; data: Uint8Array }>
  dropIndexCalls: string[]
  setStatsSchema: (schema: Record<string, unknown>) => void
}

function makeMockEngine(restoreDelayMs = 0): MockEngineHandle {
  let hasIndex = false
  let statsSchema: Record<string, unknown> = { title: 'text' }
  const restoreCalls: Array<{ indexName: string; data: Uint8Array }> = []
  const dropIndexCalls: string[] = []

  const engine = {
    listIndexes: () => (hasIndex ? [{ name: 'products' }] : []),
    dropIndex: async (name: string) => {
      hasIndex = false
      dropIndexCalls.push(name)
    },
    restore: async (indexName: string, data: Uint8Array) => {
      if (restoreDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, restoreDelayMs))
      }
      hasIndex = true
      restoreCalls.push({ indexName, data })
    },
    getStats: (_indexName: string) => ({ schema: statsSchema }),
  } as unknown as Narsil

  return {
    engine,
    restoreCalls,
    dropIndexCalls,
    setStatsSchema: (schema: Record<string, unknown>) => {
      statsSchema = schema
    },
  }
}

function makeCoordinator(schema: Record<string, unknown> | null = { title: 'text' }): ClusterCoordinator {
  return {
    getSchema: vi.fn().mockResolvedValue(schema),
  } as unknown as ClusterCoordinator
}

function buildStart(indexName: string, totalBytes: number, checksum: number): Uint8Array {
  const header: ReplicationSnapshotHeader = {
    lastSeqNo: 0,
    primaryTerm: 0,
    partitionId: 0,
    indexName,
    checksum,
  }
  const payload: SnapshotStartPayload = { header, totalBytes }
  return encode(payload)
}

function buildChunk(indexName: string, offset: number, data: Uint8Array): Uint8Array {
  const payload: SnapshotChunkPayload = { partitionId: 0, indexName, offset, data }
  return encode(payload)
}

function buildEnd(indexName: string, totalBytes: number, checksum: number): Uint8Array {
  const payload: SnapshotEndPayload = { partitionId: 0, indexName, totalBytes, checksum }
  return encode(payload)
}

function makeScriptedSnapshot(indexName: string, totalBytes: number): Uint8Array[] {
  const bytes = new Uint8Array(totalBytes)
  for (let i = 0; i < totalBytes; i++) {
    bytes[i] = (i * 17 + 3) % 256
  }
  const checksum = crc32(bytes)
  const chunks: Uint8Array[] = []
  chunks.push(buildStart(indexName, totalBytes, checksum))
  let offset = 0
  while (offset < totalBytes) {
    const end = Math.min(offset + SNAPSHOT_CHUNK_SIZE, totalBytes)
    chunks.push(buildChunk(indexName, offset, bytes.subarray(offset, end)))
    offset = end
  }
  chunks.push(buildEnd(indexName, totalBytes, checksum))
  return chunks
}

interface ScriptedTransport {
  transport: NodeTransport
  streamCalls: number
  setChunks: (chunks: Uint8Array[]) => void
}

function makeTransport(): ScriptedTransport {
  let chunks: Uint8Array[] = []
  const self: ScriptedTransport = {
    streamCalls: 0,
    transport: {
      send: async () => {
        throw new Error('send not used')
      },
      stream: async (_target, _message, handler) => {
        self.streamCalls += 1
        for (const chunk of chunks) {
          handler(chunk)
        }
      },
      listen: async () => () => {},
      shutdown: async () => {},
    },
    setChunks: c => {
      chunks = c
    },
  }
  return self
}

function makeDeps(
  engine: Narsil,
  coordinator: ClusterCoordinator,
  transport: NodeTransport,
  overrides: Partial<BootstrapSyncDeps> = {},
): BootstrapSyncDeps {
  return {
    engine,
    coordinator,
    transport,
    sourceNodeId: 'replica-node',
    resolveNodeTargets: async nodeId => [nodeId],
    ...overrides,
  }
}

describe('bootstrap sync pass-4 findings', () => {
  let mockEngine: MockEngineHandle
  let coordinator: ClusterCoordinator
  let scripted: ScriptedTransport

  beforeEach(() => {
    mockEngine = makeMockEngine()
    coordinator = makeCoordinator()
    scripted = makeTransport()
  })

  it('M-A: clear fired during restore drops the restored index so engine state matches onError', async () => {
    mockEngine = makeMockEngine(150)
    scripted.setChunks(makeScriptedSnapshot('products', 1024))

    const state = createBootstrapSyncState()
    const onError = vi.fn()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError })

    const syncPromise = runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    await new Promise(resolve => setTimeout(resolve, 40))
    clearBootstrapSyncIndex(state, 'products', 0)

    const result = await syncPromise
    expect(result).toBe(false)
    expect(state.completed.has('products:0')).toBe(false)
    expect(mockEngine.engine.listIndexes().find(i => i.name === 'products')).toBeUndefined()

    const err = onError.mock.calls.at(-1)?.[0] as NarsilError
    expect(err.code).toBe(ErrorCodes.SNAPSHOT_SYNC_ABORTED)
  })

  it('L-A: generation counter is reclaimed after a clear when no in-flight worker remains', async () => {
    scripted.setChunks(makeScriptedSnapshot('products', 256))
    const state = createBootstrapSyncState()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport)

    await runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    expect(state.completed.has('products:0')).toBe(true)

    clearBootstrapSyncIndex(state, 'products', 0)
    expect(state.generations.has('products:0')).toBe(false)
  })

  it('L-B: clearBootstrapSyncIndex releases waiters immediately even when engine.restore is slow', async () => {
    mockEngine = makeMockEngine(400)
    scripted.setChunks(makeScriptedSnapshot('products', 256))

    const state = createBootstrapSyncState()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport)

    const worker = runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    await new Promise(resolve => setTimeout(resolve, 20))
    const waiter = runBootstrapSync(state, 'products', 0, 'primary-node', deps)

    const clearAt = Date.now()
    clearBootstrapSyncIndex(state, 'products', 0)
    const waiterResult = await waiter
    const waiterTookMs = Date.now() - clearAt

    expect(waiterResult).toBe(false)
    expect(waiterTookMs).toBeLessThan(120)
    await worker
  })

  it('L-C: a restored schema that disagrees with the coordinator schema is dropped and reported', async () => {
    mockEngine = makeMockEngine()
    mockEngine.setStatsSchema({ title: 'text', extra: 'number' })
    coordinator = makeCoordinator({ title: 'text' })
    scripted.setChunks(makeScriptedSnapshot('products', 256))

    const state = createBootstrapSyncState()
    const onError = vi.fn()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError })

    const result = await runBootstrapSync(state, 'products', 0, 'primary-node', deps)

    expect(result).toBe(false)
    expect(state.completed.has('products:0')).toBe(false)
    expect(mockEngine.dropIndexCalls).toContain('products')

    const lastError = onError.mock.calls.at(-1)?.[0] as NarsilError
    expect(lastError.code).toBe(ErrorCodes.NODE_BOOTSTRAP_FAILED)
    expect(lastError.details.reason).toBe('schema mismatch')
    const differences = lastError.details.differences as Array<{ path: string }>
    expect(Array.isArray(differences)).toBe(true)
    expect(differences.some(d => d.path === 'extra')).toBe(true)
  })

  it('M-new-1: dropExistingIndex treats INDEX_NOT_FOUND race as success', async () => {
    const racingEngine = {
      listIndexes: () => [{ name: 'products' }],
      dropIndex: async (_name: string) => {
        throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, 'Index "products" does not exist', {
          indexName: 'products',
        })
      },
    } as unknown as Narsil

    const result = await dropExistingIndex(racingEngine, 'products', 'primary-node')
    expect(result).toBeNull()
  })

  it('M-new-1: dropExistingIndex still wraps non-INDEX_NOT_FOUND errors as RESTORE_FAILED', async () => {
    const brokenEngine = {
      listIndexes: () => [{ name: 'products' }],
      dropIndex: async (_name: string) => {
        throw new Error('disk failure')
      },
    } as unknown as Narsil

    const result = await dropExistingIndex(brokenEngine, 'products', 'primary-node')
    expect(result).not.toBeNull()
    expect(result?.code).toBe(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED)
  })

  it('M-new-2: after clear during restore, a fresh runBootstrapSync starts a new bootstrap rather than absorbing', async () => {
    mockEngine = makeMockEngine(200)
    scripted.setChunks(makeScriptedSnapshot('products', 1024))

    const state = createBootstrapSyncState()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport)

    const first = runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    await new Promise(resolve => setTimeout(resolve, 40))
    clearBootstrapSyncIndex(state, 'products', 0)

    // Immediately after the clear, the in-flight map must not still point at
    // the evicted entry. A fresh runBootstrapSync for the same key must kick
    // off a brand-new bootstrap (distinct transport.stream invocation) rather
    // than absorbing the aborted entry.
    expect(state.inFlight.has('products:0')).toBe(false)

    const second = runBootstrapSync(state, 'products', 0, 'primary-node', deps)

    const firstResult = await first
    const secondResult = await second

    expect(firstResult).toBe(false)
    expect(secondResult).toBe(true)

    expect(scripted.streamCalls).toBeGreaterThanOrEqual(2)
    expect(state.completed.has('products:0')).toBe(true)
    expect(mockEngine.engine.listIndexes().find(i => i.name === 'products')).toBeDefined()
  })

  it('I-new-1: dropRestoredIndexQuietly surfaces cleanup failure via onError with SNAPSHOT_SYNC_RESTORE_CLEANUP_FAILED', async () => {
    // Build an engine that succeeds restore but deterministically fails any
    // drop after the restore completes. Schema mismatch triggers cleanup
    // which must now surface via onError under a dedicated error code.
    let hasIndex = false
    const failingEngine = {
      listIndexes: () => (hasIndex ? [{ name: 'products' }] : []),
      dropIndex: async (_name: string) => {
        if (hasIndex) {
          throw new Error('simulated cleanup failure')
        }
      },
      restore: async (_indexName: string, _data: Uint8Array) => {
        hasIndex = true
      },
      getStats: (_indexName: string) => ({ schema: { title: 'text', extra: 'number' } }),
    } as unknown as Narsil

    coordinator = makeCoordinator({ title: 'text' })
    scripted.setChunks(makeScriptedSnapshot('products', 256))

    const state = createBootstrapSyncState()
    const onError = vi.fn()
    const deps = makeDeps(failingEngine, coordinator, scripted.transport, { onError })

    const result = await runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    expect(result).toBe(false)

    const observed = onError.mock.calls.map(c => (c[0] as NarsilError).code)
    expect(observed).toContain(ErrorCodes.SNAPSHOT_SYNC_RESTORE_CLEANUP_FAILED)

    const cleanupError = onError.mock.calls
      .map(c => c[0] as NarsilError)
      .find(e => e.code === ErrorCodes.SNAPSHOT_SYNC_RESTORE_CLEANUP_FAILED)
    expect(cleanupError?.details.indexName).toBe('products')
  })
})
