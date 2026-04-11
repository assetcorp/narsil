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
import {
  type NodeTransport,
  type ReplicationSnapshotHeader,
  type SnapshotChunkPayload,
  type SnapshotEndPayload,
  type SnapshotStartPayload,
  TransportError,
  TransportErrorCodes,
  type TransportMessage,
} from '../../../distribution/transport/types'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { Narsil } from '../../../narsil'
import { crc32 } from '../../../serialization/crc32'

type ScriptedChunk = Uint8Array

interface MockEngineOptions {
  hasIndex?: boolean
  restoreRejects?: Error
  createIndexRejects?: Error
  statsSchema?: Record<string, unknown>
}

interface MockEngineHandle {
  engine: Narsil
  restoreCalls: Array<{ indexName: string; data: Uint8Array }>
  createIndexCalls: string[]
  dropIndexCalls: string[]
  setHasIndex: (value: boolean) => void
}

function makeMockEngine(options: MockEngineOptions = {}): MockEngineHandle {
  let hasIndex = options.hasIndex ?? false
  const restoreCalls: Array<{ indexName: string; data: Uint8Array }> = []
  const createIndexCalls: string[] = []
  const dropIndexCalls: string[] = []

  const statsSchema = options.statsSchema ?? { title: 'text' }
  const engine = {
    listIndexes: () => (hasIndex ? [{ name: 'products' }] : []),
    createIndex: async (name: string) => {
      if (options.createIndexRejects !== undefined) {
        throw options.createIndexRejects
      }
      hasIndex = true
      createIndexCalls.push(name)
    },
    dropIndex: async (name: string) => {
      hasIndex = false
      dropIndexCalls.push(name)
    },
    restore: async (indexName: string, data: Uint8Array) => {
      if (options.restoreRejects !== undefined) {
        throw options.restoreRejects
      }
      hasIndex = true
      restoreCalls.push({ indexName, data })
    },
    getStats: (_indexName: string) => ({ schema: statsSchema }),
  } as unknown as Narsil

  return {
    engine,
    restoreCalls,
    createIndexCalls,
    dropIndexCalls,
    setHasIndex: (value: boolean) => {
      hasIndex = value
    },
  }
}

function makeMockCoordinator(schema: Record<string, string> | null): ClusterCoordinator {
  return {
    getSchema: vi.fn().mockResolvedValue(schema),
  } as unknown as ClusterCoordinator
}

function buildSnapshotStartBytes(
  indexName: string,
  totalBytes: number,
  checksum: number,
  headerOverrides: Partial<ReplicationSnapshotHeader> = {},
): Uint8Array {
  const header: ReplicationSnapshotHeader = {
    lastSeqNo: 0,
    primaryTerm: 0,
    partitionId: 0,
    indexName,
    checksum,
    ...headerOverrides,
  }
  const payload: SnapshotStartPayload = { header, totalBytes }
  return encode(payload)
}

function buildSnapshotChunkBytes(indexName: string, offset: number, data: Uint8Array, partitionId = 0): Uint8Array {
  const payload: SnapshotChunkPayload = { partitionId, indexName, offset, data }
  return encode(payload)
}

function buildSnapshotEndBytes(indexName: string, totalBytes: number, checksum: number): Uint8Array {
  const payload: SnapshotEndPayload = { partitionId: 0, indexName, totalBytes, checksum }
  return encode(payload)
}

function buildErrorEnvelopeBytes(code: string, message: string): Uint8Array {
  return encode({ error: true, code, message })
}

function makeScriptedSnapshot(
  indexName: string,
  totalBytes: number,
): {
  chunks: ScriptedChunk[]
  bytes: Uint8Array
  checksum: number
} {
  const bytes = new Uint8Array(totalBytes)
  for (let i = 0; i < totalBytes; i++) {
    bytes[i] = (i * 31 + 7) % 256
  }
  const checksum = crc32(bytes)
  const chunks: ScriptedChunk[] = []
  chunks.push(buildSnapshotStartBytes(indexName, totalBytes, checksum))
  let offset = 0
  while (offset < totalBytes) {
    const end = Math.min(offset + SNAPSHOT_CHUNK_SIZE, totalBytes)
    chunks.push(buildSnapshotChunkBytes(indexName, offset, bytes.subarray(offset, end)))
    offset = end
  }
  chunks.push(buildSnapshotEndBytes(indexName, totalBytes, checksum))
  return { chunks, bytes, checksum }
}

interface ScriptedTransport {
  transport: NodeTransport
  streamCalls: Array<{ target: string; message: TransportMessage }>
  setScript: (script: ScriptedChunk[] | 'reject' | Error) => void
  setPerTargetScript: (perTarget: Record<string, ScriptedChunk[] | Error>) => void
}

function makeScriptedTransport(initial: ScriptedChunk[] | 'reject' | Error = []): ScriptedTransport {
  const streamCalls: Array<{ target: string; message: TransportMessage }> = []
  let script: ScriptedChunk[] | 'reject' | Error = initial
  let perTarget: Record<string, ScriptedChunk[] | Error> | null = null

  const transport: NodeTransport = {
    send: async () => {
      throw new Error('send not implemented in mock')
    },
    stream: async (target, message, handler) => {
      streamCalls.push({ target, message })
      if (perTarget !== null) {
        const entry = perTarget[target]
        if (entry instanceof Error) {
          throw entry
        }
        if (entry === undefined) {
          return
        }
        for (const chunk of entry) {
          handler(chunk)
        }
        return
      }
      if (script instanceof Error) {
        throw script
      }
      if (script === 'reject') {
        throw new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, 'peer unavailable')
      }
      for (const chunk of script) {
        handler(chunk)
      }
    },
    listen: async () => () => {},
    shutdown: async () => {},
  }

  return {
    transport,
    streamCalls,
    setScript: value => {
      script = value
      perTarget = null
    },
    setPerTargetScript: value => {
      perTarget = value
    },
  }
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

describe('runBootstrapSync', () => {
  let mockEngine: ReturnType<typeof makeMockEngine>
  let coordinator: ClusterCoordinator
  let scripted: ScriptedTransport

  beforeEach(() => {
    mockEngine = makeMockEngine()
    coordinator = makeMockCoordinator({ title: 'text' })
    scripted = makeScriptedTransport()
  })

  it('happy path: assembles chunks, verifies checksum, calls engine.restore', async () => {
    const { chunks, bytes } = makeScriptedSnapshot('products', SNAPSHOT_CHUNK_SIZE * 3 + 42)
    scripted.setScript(chunks)

    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport),
    )

    expect(result).toBe(true)
    expect(mockEngine.restoreCalls.length).toBe(1)
    expect(mockEngine.restoreCalls[0].indexName).toBe('products')
    expect(mockEngine.restoreCalls[0].data).toEqual(bytes)
    expect(state.completed.has('products:0')).toBe(true)
    expect(state.inFlight.has('products:0')).toBe(false)
  })

  it('pre-allocates a contiguous buffer for assembly rather than copying per chunk', async () => {
    const totalBytes = SNAPSHOT_CHUNK_SIZE * 2 + 17
    const { chunks, bytes } = makeScriptedSnapshot('products', totalBytes)
    scripted.setScript(chunks)

    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport),
    )

    expect(result).toBe(true)
    const delivered = mockEngine.restoreCalls[0].data
    expect(delivered.byteLength).toBe(totalBytes)
    expect(delivered).toEqual(bytes)
  })

  it('surfaces an out-of-order chunk failure with a typed error code', async () => {
    const totalBytes = SNAPSHOT_CHUNK_SIZE * 2
    const bytes = new Uint8Array(totalBytes)
    bytes.fill(7)
    const checksum = crc32(bytes)

    const chunks: ScriptedChunk[] = [
      buildSnapshotStartBytes('products', totalBytes, checksum),
      buildSnapshotChunkBytes('products', SNAPSHOT_CHUNK_SIZE, bytes.subarray(SNAPSHOT_CHUNK_SIZE, totalBytes)),
      buildSnapshotChunkBytes('products', 0, bytes.subarray(0, SNAPSHOT_CHUNK_SIZE)),
      buildSnapshotEndBytes('products', totalBytes, checksum),
    ]
    scripted.setScript(chunks)

    const onError = vi.fn()
    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError }),
    )

    expect(result).toBe(false)
    expect(mockEngine.restoreCalls.length).toBe(0)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err).toBeInstanceOf(NarsilError)
    expect(err.code).toBe(ErrorCodes.NODE_BOOTSTRAP_FAILED)
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER)
  })

  it('surfaces a checksum mismatch failure with a typed error code', async () => {
    const totalBytes = 1024
    const bytes = new Uint8Array(totalBytes)
    bytes.fill(42)
    const realChecksum = crc32(bytes)

    const chunks: ScriptedChunk[] = [
      buildSnapshotStartBytes('products', totalBytes, realChecksum),
      buildSnapshotChunkBytes('products', 0, new Uint8Array(totalBytes)),
      buildSnapshotEndBytes('products', totalBytes, realChecksum),
    ]
    scripted.setScript(chunks)

    const onError = vi.fn()
    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError }),
    )

    expect(result).toBe(false)
    expect(mockEngine.restoreCalls.length).toBe(0)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_CHECKSUM_MISMATCH)
  })

  it('surfaces SNAPSHOT_SYNC_TOO_LARGE when totalBytes exceeds the limit', async () => {
    const hugeStart = encode({
      header: {
        lastSeqNo: 0,
        primaryTerm: 0,
        partitionId: 0,
        indexName: 'products',
        checksum: 0,
      },
      totalBytes: 3 * 1024 * 1024 * 1024,
    })
    scripted.setScript([hugeStart])

    const onError = vi.fn()
    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError }),
    )

    expect(result).toBe(false)
    expect(mockEngine.restoreCalls.length).toBe(0)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_TOO_LARGE)
  })

  it('surfaces SNAPSHOT_SYNC_PRIMARY_ERROR when the primary sends an error envelope', async () => {
    scripted.setScript([buildErrorEnvelopeBytes('INDEX_NOT_FOUND', 'missing')])

    const onError = vi.fn()
    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError }),
    )

    expect(result).toBe(false)
    expect(mockEngine.restoreCalls.length).toBe(0)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_PRIMARY_ERROR)
    expect(err.details.primaryCode).toBe('INDEX_NOT_FOUND')
    expect(err.details.primaryMessage).toBe('missing')
  })

  it('surfaces a mid-stream error envelope rather than misclassifying it as UNEXPECTED_FRAME', async () => {
    const totalBytes = 1024
    const { checksum } = makeScriptedSnapshot('products', totalBytes)

    const chunks: ScriptedChunk[] = [
      buildSnapshotStartBytes('products', totalBytes, checksum),
      buildErrorEnvelopeBytes('PRIMARY_CRASHED', 'primary died mid stream'),
    ]
    scripted.setScript(chunks)

    const onError = vi.fn()
    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError }),
    )

    expect(result).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_PRIMARY_ERROR)
    expect(err.details.primaryCode).toBe('PRIMARY_CRASHED')
  })

  it('surfaces a header mismatch when a chunk indexName does not match the header', async () => {
    const totalBytes = SNAPSHOT_CHUNK_SIZE
    const bytes = new Uint8Array(totalBytes)
    bytes.fill(3)
    const checksum = crc32(bytes)

    const chunks: ScriptedChunk[] = [
      buildSnapshotStartBytes('products', totalBytes, checksum),
      buildSnapshotChunkBytes('other-index', 0, bytes),
      buildSnapshotEndBytes('products', totalBytes, checksum),
    ]
    scripted.setScript(chunks)

    const onError = vi.fn()
    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError }),
    )

    expect(result).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_HEADER_MISMATCH)
  })

  it('surfaces a header mismatch when a chunk partitionId does not match the header', async () => {
    const totalBytes = 256
    const bytes = new Uint8Array(totalBytes)
    bytes.fill(9)
    const checksum = crc32(bytes)

    const chunks: ScriptedChunk[] = [
      buildSnapshotStartBytes('products', totalBytes, checksum),
      buildSnapshotChunkBytes('products', 0, bytes, 7),
      buildSnapshotEndBytes('products', totalBytes, checksum),
    ]
    scripted.setScript(chunks)

    const onError = vi.fn()
    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError }),
    )

    expect(result).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_HEADER_MISMATCH)
  })

  it('surfaces SNAPSHOT_SYNC_HEADER_INVALID when numeric fields are non-integer', async () => {
    const nonIntStart = encode({
      header: {
        lastSeqNo: 0.5,
        primaryTerm: 0,
        partitionId: 0,
        indexName: 'products',
        checksum: 12,
      },
      totalBytes: 16,
    })
    scripted.setScript([nonIntStart])

    const onError = vi.fn()
    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError }),
    )

    expect(result).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_HEADER_INVALID)
  })

  it('surfaces SNAPSHOT_SYNC_CHUNK_MISSING when the stream ends before SNAPSHOT_START', async () => {
    scripted.setScript([])

    const onError = vi.fn()
    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError }),
    )

    expect(result).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_CHUNK_MISSING)
  })

  it('surfaces SNAPSHOT_SYNC_END_MISSING when SNAPSHOT_END never arrives', async () => {
    const totalBytes = 64
    const bytes = new Uint8Array(totalBytes)
    bytes.fill(5)
    const checksum = crc32(bytes)
    scripted.setScript([
      buildSnapshotStartBytes('products', totalBytes, checksum),
      buildSnapshotChunkBytes('products', 0, bytes),
    ])

    const onError = vi.fn()
    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError }),
    )

    expect(result).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_END_MISSING)
  })

  it('fails over from a failed target to the next reachable one and attributes the last failure correctly', async () => {
    const { chunks, bytes } = makeScriptedSnapshot('products', 2_000)
    scripted.setPerTargetScript({
      'primary-node': new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, 'down'),
      'primary-node:9200': chunks,
    })

    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, {
        resolveNodeTargets: async () => ['primary-node', 'primary-node:9200'],
      }),
    )

    expect(result).toBe(true)
    expect(mockEngine.restoreCalls.length).toBe(1)
    expect(mockEngine.restoreCalls[0].data).toEqual(bytes)
    expect(scripted.streamCalls.length).toBe(2)
  })

  it('parallel calls for the same index share a single transport stream', async () => {
    const { chunks } = makeScriptedSnapshot('products', SNAPSHOT_CHUNK_SIZE + 100)
    scripted.setScript(chunks)

    const state = createBootstrapSyncState()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport)

    const [result1, result2, result3] = await Promise.all([
      runBootstrapSync(state, 'products', 0, 'primary-node', deps),
      runBootstrapSync(state, 'products', 0, 'primary-node', deps),
      runBootstrapSync(state, 'products', 0, 'primary-node', deps),
    ])

    expect(result1).toBe(true)
    expect(result2).toBe(true)
    expect(result3).toBe(true)
    expect(scripted.streamCalls.length).toBe(1)
    expect(mockEngine.restoreCalls.length).toBe(1)
  })

  it('short-circuits when the index is already in the completed set', async () => {
    const { chunks } = makeScriptedSnapshot('products', 1024)
    scripted.setScript(chunks)

    const state = createBootstrapSyncState()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport)

    const first = await runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    expect(first).toBe(true)
    expect(scripted.streamCalls.length).toBe(1)

    const second = await runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    expect(second).toBe(true)
    expect(scripted.streamCalls.length).toBe(1)
    expect(mockEngine.restoreCalls.length).toBe(1)
  })

  it('clearBootstrapSyncIndex re-runs the sync for a previously completed index', async () => {
    const { chunks } = makeScriptedSnapshot('products', 1024)
    scripted.setScript(chunks)

    const state = createBootstrapSyncState()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport)

    await runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    expect(state.completed.has('products:0')).toBe(true)

    clearBootstrapSyncIndex(state, 'products', 0)
    expect(state.completed.has('products:0')).toBe(false)

    scripted.setScript(chunks)
    await runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    expect(scripted.streamCalls.length).toBe(2)
    expect(mockEngine.restoreCalls.length).toBe(2)
  })

  it('surfaces SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE when the coordinator has no schema and the index is missing', async () => {
    const nullCoordinator = makeMockCoordinator(null)
    const onError = vi.fn()
    const state = createBootstrapSyncState()

    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, nullCoordinator, scripted.transport, { onError }),
    )

    expect(result).toBe(false)
    expect(scripted.streamCalls.length).toBe(0)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE)
  })

  it('surfaces SNAPSHOT_SYNC_RESTORE_FAILED when engine.restore throws', async () => {
    const rejectingEngine = makeMockEngine({ restoreRejects: new Error('corruption') })
    const { chunks } = makeScriptedSnapshot('products', 1024)
    scripted.setScript(chunks)

    const errorSpy = vi.fn()
    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(rejectingEngine.engine, coordinator, scripted.transport, { onError: errorSpy }),
    )

    expect(result).toBe(false)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const err = errorSpy.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED)
    expect(state.completed.has('products:0')).toBe(false)
  })

  it('fetches the schema when the local index is missing and does not pre-create the empty shell', async () => {
    const getSchemaSpy = vi.fn().mockResolvedValue({ title: 'text' })
    const coord: ClusterCoordinator = { getSchema: getSchemaSpy } as unknown as ClusterCoordinator

    const { chunks } = makeScriptedSnapshot('products', 1024)
    scripted.setScript(chunks)

    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coord, scripted.transport),
    )

    expect(result).toBe(true)
    expect(getSchemaSpy).toHaveBeenCalledTimes(1)
    expect(mockEngine.createIndexCalls).toEqual([])
    expect(mockEngine.restoreCalls.length).toBe(1)
  })

  it('surfaces SNAPSHOT_SYNC_REQUEST_INVALID for an empty indexName', async () => {
    const onError = vi.fn()
    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      '',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError }),
    )

    expect(result).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID)
  })

  it('surfaces SNAPSHOT_SYNC_NO_TARGETS when resolveNodeTargets returns an empty list', async () => {
    const onError = vi.fn()
    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, {
        onError,
        resolveNodeTargets: async () => [],
      }),
    )

    expect(result).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_NO_TARGETS)
  })

  it('surfaces SNAPSHOT_SYNC_TIMEOUT when the deadline expires before any target is tried', async () => {
    const onError = vi.fn()
    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, {
        onError,
        deadlineMs: 0,
      }),
    )

    expect(result).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0] as NarsilError
    expect(err.details.innerCode).toBe(ErrorCodes.SNAPSHOT_SYNC_TIMEOUT)
  })
})
