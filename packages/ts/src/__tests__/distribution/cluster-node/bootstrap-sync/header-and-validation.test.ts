import { encode } from '@msgpack/msgpack'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBootstrapSyncState, runBootstrapSync } from '../../../../distribution/cluster-node/bootstrap-sync'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
import { SNAPSHOT_CHUNK_SIZE } from '../../../../distribution/replication/snapshot-constants'
import { ErrorCodes, type NarsilError } from '../../../../errors'
import { crc32 } from '../../../../serialization/crc32'
import {
  buildSnapshotChunkBytes,
  buildSnapshotEndBytes,
  buildSnapshotStartBytes,
  makeDeps,
  makeMockCoordinator,
  makeMockEngine,
  makeScriptedSnapshot,
  makeScriptedTransport,
  type ScriptedChunk,
  type ScriptedTransport,
} from './fixtures'

describe('runBootstrapSync - header validation and request errors', () => {
  let mockEngine: ReturnType<typeof makeMockEngine>
  let coordinator: ClusterCoordinator
  let scripted: ScriptedTransport

  beforeEach(() => {
    mockEngine = makeMockEngine()
    coordinator = makeMockCoordinator({ title: 'text' })
    scripted = makeScriptedTransport()
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
})
