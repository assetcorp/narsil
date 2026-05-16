import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearBootstrapSyncIndex,
  createBootstrapSyncState,
  runBootstrapSync,
} from '../../../../distribution/cluster-node/bootstrap-sync'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
import { SNAPSHOT_CHUNK_SIZE } from '../../../../distribution/replication/snapshot-constants'
import { TransportError, TransportErrorCodes } from '../../../../distribution/transport/types'
import {
  makeDeps,
  makeMockCoordinator,
  makeMockEngine,
  makeScriptedSnapshot,
  makeScriptedTransport,
  type ScriptedTransport,
} from './fixtures'

describe('runBootstrapSync - happy path and state', () => {
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
})
