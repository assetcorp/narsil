import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearBootstrapSyncIndex,
  createBootstrapSyncState,
  runBootstrapSync,
} from '../../../../distribution/cluster-node/bootstrap-sync'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
import { SNAPSHOT_CHUNK_SIZE } from '../../../../distribution/replication/constants'
import { ErrorCodes, type NarsilError } from '../../../../errors'
import { crc32 } from '../../../../serialization/crc32'
import {
  buildErrorEnvelopeBytes,
  buildSnapshotChunkBytes,
  buildSnapshotEndBytes,
  buildSnapshotStartBytes,
  type MockEngineHandle,
  makeDeps,
  makeMockCoordinator,
  makeMockEngine,
  makeScriptedSnapshot,
  makeScriptedTransport,
  type ScriptedTransport,
} from './fixtures'

describe('bootstrap sync hardening', () => {
  let mockEngine: MockEngineHandle
  let coordinator: ClusterCoordinator
  let scripted: ScriptedTransport

  beforeEach(() => {
    mockEngine = makeMockEngine()
    coordinator = makeMockCoordinator({ title: 'text' })
    scripted = makeScriptedTransport()
  })

  it('T4: clearBootstrapSyncIndex aborts an in-flight run so the completed set is not repopulated', async () => {
    scripted.setScript(makeScriptedSnapshot('products', 1024).chunks)

    const state = createBootstrapSyncState()
    const onError = vi.fn()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError })

    const releaseRestore = mockEngine.holdRestore()
    const syncPromise = runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    await mockEngine.restoreStarted
    clearBootstrapSyncIndex(state, 'products', 0)
    releaseRestore()

    const result = await syncPromise
    expect(result).toBe(false)
    expect(state.completed.has('products:0')).toBe(false)
    expect(onError).toHaveBeenCalled()
    const err = onError.mock.calls[onError.mock.calls.length - 1][0] as NarsilError
    expect(err.code).toBe(ErrorCodes.SNAPSHOT_SYNC_ABORTED)
  })

  it('T4b: a subsequent call after abort runs a fresh sync instead of short-circuiting', async () => {
    scripted.setScript(makeScriptedSnapshot('products', 1024).chunks)
    const state = createBootstrapSyncState()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport)

    const releaseRestore = mockEngine.holdRestore()
    const first = runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    await mockEngine.restoreStarted
    clearBootstrapSyncIndex(state, 'products', 0)
    releaseRestore()
    await first

    const second = await runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    expect(second).toBe(true)
    expect(state.completed.has('products:0')).toBe(true)
    expect(scripted.streamCalls).toHaveLength(2)
  })

  it('T5: deadline firing during stream surfaces SNAPSHOT_SYNC_TIMEOUT and skips restore', async () => {
    scripted.setScript(makeScriptedSnapshot('products', SNAPSHOT_CHUNK_SIZE * 4).chunks)
    scripted.setChunkDelayMs(60)

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
    mockEngine = makeMockEngine({ restoreDelayMs: 200 })
    scripted.setScript(makeScriptedSnapshot('products', 512).chunks)

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
    mockEngine = makeMockEngine({ hasIndex: true })
    scripted.setScript(makeScriptedSnapshot('products', 1024).chunks)
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
    scripted.setScript([
      buildSnapshotStartBytes('products', totalBytes, checksum),
      buildSnapshotChunkBytes('products', SNAPSHOT_CHUNK_SIZE, bytes.subarray(SNAPSHOT_CHUNK_SIZE, totalBytes)),
      buildSnapshotChunkBytes('products', 0, bytes.subarray(0, SNAPSHOT_CHUNK_SIZE)),
      buildSnapshotEndBytes('products', totalBytes, checksum),
    ])

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
    scripted.setScript(makeScriptedSnapshot('products', 512).chunks)
    const state = createBootstrapSyncState()

    const first = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport),
    )
    const secondEngine = makeMockEngine()
    const second = await runBootstrapSync(
      state,
      'products',
      1,
      'primary-node',
      makeDeps(secondEngine.engine, coordinator, scripted.transport),
    )

    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(state.completed.has('products:0')).toBe(true)
    expect(state.completed.has('products:1')).toBe(true)
  })

  it('partial-error taxonomy: primary error with transient inner code retries on next target', async () => {
    scripted.setPerTargetScript({
      'target-a': [buildErrorEnvelopeBytes(ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED, 'busy')],
      'target-b': makeScriptedSnapshot('products', 512).chunks,
    })

    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, {
        resolveNodeTargets: async () => ['target-a', 'target-b'],
      }),
    )

    expect(result).toBe(true)
    expect(state.completed.has('products:0')).toBe(true)
    expect(scripted.streamCalls).toHaveLength(2)
  })

  it('checksum mismatch now fails over to the next target instead of aborting all targets', async () => {
    const totalBytes = 64
    const realBytes = new Uint8Array(totalBytes)
    realBytes.fill(7)
    const realChecksum = crc32(realBytes)

    scripted.setPerTargetScript({
      'target-a': [
        buildSnapshotStartBytes('products', totalBytes, realChecksum),
        buildSnapshotChunkBytes('products', 0, new Uint8Array(totalBytes)),
        buildSnapshotEndBytes('products', totalBytes, realChecksum),
      ],
      'target-b': makeScriptedSnapshot('products', totalBytes).chunks,
    })

    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeDeps(mockEngine.engine, coordinator, scripted.transport, {
        resolveNodeTargets: async () => ['target-a', 'target-b'],
      }),
    )
    expect(result).toBe(true)
    expect(scripted.streamCalls).toHaveLength(2)
  })
})
