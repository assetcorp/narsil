import { encode } from '@msgpack/msgpack'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBootstrapSyncState, runBootstrapSync } from '../../../../distribution/cluster-node/bootstrap-sync'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
import { SNAPSHOT_CHUNK_SIZE } from '../../../../distribution/replication/snapshot-constants'
import { ErrorCodes, type NarsilError } from '../../../../errors'
import { crc32 } from '../../../../serialization/crc32'
import {
  buildErrorEnvelopeBytes,
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

describe('runBootstrapSync - chunk and stream errors', () => {
  let mockEngine: ReturnType<typeof makeMockEngine>
  let coordinator: ClusterCoordinator
  let scripted: ScriptedTransport

  beforeEach(() => {
    mockEngine = makeMockEngine()
    coordinator = makeMockCoordinator({ title: 'text' })
    scripted = makeScriptedTransport()
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
})
