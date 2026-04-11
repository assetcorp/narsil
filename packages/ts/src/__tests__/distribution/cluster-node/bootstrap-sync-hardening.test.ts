import { encode } from '@msgpack/msgpack'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import { ErrorCodes, type NarsilError } from '../../../errors'
import type { Narsil } from '../../../narsil'
import { crc32 } from '../../../serialization/crc32'

interface MockEngineHandle {
  engine: Narsil
  restoreCalls: Array<{ indexName: string; data: Uint8Array }>
  dropIndexCalls: string[]
  setHasIndex: (value: boolean) => void
}

function makeMockEngine(startWithIndex = false, restoreDelayMs = 0): MockEngineHandle {
  let hasIndex = startWithIndex
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
  } as unknown as Narsil

  return {
    engine,
    restoreCalls,
    dropIndexCalls,
    setHasIndex: (value: boolean) => {
      hasIndex = value
    },
  }
}

function makeCoordinator(): ClusterCoordinator {
  return {
    getSchema: vi.fn().mockResolvedValue({ title: 'text' }),
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
  setDelayPerChunkMs: (ms: number) => void
}

function makeTransport(): ScriptedTransport {
  let chunks: Uint8Array[] = []
  let delayPerChunkMs = 0
  const self: ScriptedTransport = {
    streamCalls: 0,
    transport: {
      send: async () => {
        throw new Error('send not used')
      },
      stream: async (_target, _message, handler) => {
        self.streamCalls += 1
        for (const chunk of chunks) {
          if (delayPerChunkMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayPerChunkMs))
          }
          handler(chunk)
        }
      },
      listen: async () => () => {},
      shutdown: async () => {},
    },
    setChunks: c => {
      chunks = c
    },
    setDelayPerChunkMs: ms => {
      delayPerChunkMs = ms
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

describe('bootstrap sync hardening', () => {
  let mockEngine: MockEngineHandle
  let coordinator: ClusterCoordinator
  let scripted: ScriptedTransport

  beforeEach(() => {
    mockEngine = makeMockEngine()
    coordinator = makeCoordinator()
    scripted = makeTransport()
  })

  it('T4: clearBootstrapSyncIndex aborts an in-flight run so the completed set is not repopulated', async () => {
    mockEngine = makeMockEngine(false, 100)
    scripted.setChunks(makeScriptedSnapshot('products', 1024))

    const state = createBootstrapSyncState()
    const onError = vi.fn()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError })

    const syncPromise = runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    await new Promise(resolve => setTimeout(resolve, 10))
    clearBootstrapSyncIndex(state, 'products', 0)

    const result = await syncPromise
    expect(result).toBe(false)
    expect(state.completed.has('products:0')).toBe(false)
    expect(onError).toHaveBeenCalled()
    const err = onError.mock.calls[onError.mock.calls.length - 1][0] as NarsilError
    expect(err.code).toBe(ErrorCodes.SNAPSHOT_SYNC_ABORTED)
  })

  it('T4b: a subsequent call after abort runs a fresh sync instead of short-circuiting', async () => {
    mockEngine = makeMockEngine(false, 50)
    scripted.setChunks(makeScriptedSnapshot('products', 1024))
    const state = createBootstrapSyncState()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport)

    const p1 = runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    await new Promise(resolve => setTimeout(resolve, 5))
    clearBootstrapSyncIndex(state, 'products', 0)
    await p1

    const p2 = runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    const result2 = await p2
    expect(result2).toBe(true)
    expect(state.completed.has('products:0')).toBe(true)
    expect(scripted.streamCalls).toBe(2)
  })

  it('T5: deadline firing during stream surfaces SNAPSHOT_SYNC_TIMEOUT and skips restore', async () => {
    scripted.setChunks(makeScriptedSnapshot('products', SNAPSHOT_CHUNK_SIZE * 4))
    scripted.setDelayPerChunkMs(60)

    const state = createBootstrapSyncState()
    const onError = vi.fn()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, { deadlineMs: 100, onError }),
    )
    expect(result).toBe(false)
    expect(mockEngine.restoreCalls.length).toBe(0)
    expect(onError).toHaveBeenCalled()
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_TIMEOUT)
  })

  it('T5b: deadline firing during restore surfaces SNAPSHOT_SYNC_TIMEOUT', async () => {
    mockEngine = makeMockEngine(false, 200)
    scripted.setChunks(makeScriptedSnapshot('products', 512))

    const state = createBootstrapSyncState()
    const onError = vi.fn()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, { deadlineMs: 50, onError }),
    )
    expect(result).toBe(false)
    expect(onError).toHaveBeenCalled()
    const err = onError.mock.calls[onError.mock.calls.length - 1][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_TIMEOUT)
  })

  it('T6: when the local index already exists, dropIndex is called synchronously before restore', async () => {
    mockEngine = makeMockEngine(true, 0)
    scripted.setChunks(makeScriptedSnapshot('products', 1024))
    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport),
    )
    expect(result).toBe(true)
    expect(mockEngine.dropIndexCalls).toEqual(['products'])
    expect(mockEngine.restoreCalls.length).toBe(1)
  })

  it('T7: rejects an out-of-order chunk via the shared assembler (strict in-order enforcement)', async () => {
    const totalBytes = SNAPSHOT_CHUNK_SIZE * 2
    const bytes = new Uint8Array(totalBytes)
    bytes.fill(9)
    const checksum = crc32(bytes)
    const chunks = [
      buildStart('products', totalBytes, checksum),
      buildChunk('products', SNAPSHOT_CHUNK_SIZE, bytes.subarray(SNAPSHOT_CHUNK_SIZE, totalBytes)),
      buildChunk('products', 0, bytes.subarray(0, SNAPSHOT_CHUNK_SIZE)),
      buildEnd('products', totalBytes, checksum),
    ]
    scripted.setChunks(chunks)

    const state = createBootstrapSyncState()
    const onError = vi.fn()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError }),
    )
    expect(result).toBe(false)
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER)
  })

  it('per-partition keying: two partitions of the same index have independent bootstrap state', async () => {
    scripted.setChunks(makeScriptedSnapshot('products', 512))
    const state = createBootstrapSyncState()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport)

    const r0 = await runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    mockEngine = makeMockEngine()
    const deps2 = makeDeps(mockEngine.engine, coordinator, scripted.transport)
    scripted.setChunks(makeScriptedSnapshot('products', 512))
    const r1 = await runBootstrapSync(state, 'products', 1, 'primary-node', deps2)

    expect(r0).toBe(true)
    expect(r1).toBe(true)
    expect(state.completed.has('products:0')).toBe(true)
    expect(state.completed.has('products:1')).toBe(true)
  })

  it('partial-error taxonomy: primary error with transient inner code retries on next target', async () => {
    const chunks1 = [encode({ error: true, code: ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED, message: 'busy' })]
    const chunks2 = makeScriptedSnapshot('products', 512)

    let callIdx = 0
    const transport: NodeTransport = {
      send: async () => {
        throw new Error('send not used')
      },
      stream: async (_target, _message, handler) => {
        scripted.streamCalls += 1
        const payload = callIdx === 0 ? chunks1 : chunks2
        callIdx += 1
        for (const chunk of payload) {
          handler(chunk)
        }
      },
      listen: async () => () => {},
      shutdown: async () => {},
    }

    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, transport, {
        resolveNodeTargets: async () => ['target-a', 'target-b'],
      }),
    )

    expect(result).toBe(true)
    expect(state.completed.has('products:0')).toBe(true)
  })

  it('checksum mismatch now fails over to the next target instead of aborting all targets', async () => {
    const totalBytes = 64
    const realBytes = new Uint8Array(totalBytes)
    realBytes.fill(7)
    const realChecksum = crc32(realBytes)

    const corruptChunks = [
      buildStart('products', totalBytes, realChecksum),
      buildChunk('products', 0, new Uint8Array(totalBytes)),
      buildEnd('products', totalBytes, realChecksum),
    ]
    const goodChunks = makeScriptedSnapshot('products', totalBytes)

    let callIdx = 0
    const transport: NodeTransport = {
      send: async () => {
        throw new Error('send not used')
      },
      stream: async (_target, _message, handler) => {
        const payload = callIdx === 0 ? corruptChunks : goodChunks
        callIdx += 1
        for (const chunk of payload) {
          handler(chunk)
        }
      },
      listen: async () => () => {},
      shutdown: async () => {},
    }

    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, transport, {
        resolveNodeTargets: async () => ['target-a', 'target-b'],
      }),
    )
    expect(result).toBe(true)
    expect(callIdx).toBe(2)
  })
})
