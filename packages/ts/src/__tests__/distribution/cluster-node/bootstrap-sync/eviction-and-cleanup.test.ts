import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearBootstrapSyncIndex,
  createBootstrapSyncState,
  runBootstrapSync,
} from '../../../../distribution/cluster-node/bootstrap-sync'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
import { ErrorCodes, type NarsilError } from '../../../../errors'
import {
  type MockEngineHandle,
  makeDeps,
  makeMockCoordinator,
  makeMockEngine,
  makeScriptedSnapshot,
  makeScriptedTransport,
  type ScriptedTransport,
} from './fixtures'

describe('bootstrap sync eviction and cleanup', () => {
  let mockEngine: MockEngineHandle
  let coordinator: ClusterCoordinator
  let scripted: ScriptedTransport

  beforeEach(() => {
    mockEngine = makeMockEngine()
    coordinator = makeMockCoordinator({ title: 'string' })
    scripted = makeScriptedTransport()
  })

  it('M-A: clear fired during restore aborts the sync without marking the partition complete', async () => {
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

    const err = onError.mock.calls.at(-1)?.[0] as NarsilError
    expect(err.code).toBe(ErrorCodes.SNAPSHOT_SYNC_ABORTED)
  })

  it('L-A: generation counter is reclaimed after a clear when no in-flight worker remains', async () => {
    scripted.setScript(makeScriptedSnapshot('products', 256).chunks)
    const state = createBootstrapSyncState()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport)

    await runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    expect(state.completed.has('products:0')).toBe(true)

    clearBootstrapSyncIndex(state, 'products', 0)
    expect(state.generations.has('products:0')).toBe(false)
  })

  it('L-B: clearBootstrapSyncIndex releases waiters without waiting for a slow engine.restore', async () => {
    scripted.setScript(makeScriptedSnapshot('products', 256).chunks)

    const state = createBootstrapSyncState()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport)

    const releaseRestore = mockEngine.holdRestore()
    const worker = runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    await mockEngine.restoreStarted
    const waiter = runBootstrapSync(state, 'products', 0, 'primary-node', deps)

    clearBootstrapSyncIndex(state, 'products', 0)
    const waiterResult = await waiter

    expect(waiterResult).toBe(false)
    expect(mockEngine.restoreCalls).toHaveLength(0)

    releaseRestore()
    await worker
  })

  it('L-C: a restored schema that disagrees with the coordinator schema is reported and not marked complete', async () => {
    mockEngine = makeMockEngine({ statsSchema: { title: 'string', extra: 'number' } })
    scripted.setScript(makeScriptedSnapshot('products', 256).chunks)

    const state = createBootstrapSyncState()
    const onError = vi.fn()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport, { onError })

    const result = await runBootstrapSync(state, 'products', 0, 'primary-node', deps)

    expect(result).toBe(false)
    expect(state.completed.has('products:0')).toBe(false)

    const lastError = onError.mock.calls.at(-1)?.[0] as NarsilError
    expect(lastError.code).toBe(ErrorCodes.NODE_BOOTSTRAP_FAILED)
    expect(lastError.details.reason).toBe('schema mismatch')
    const differences = lastError.details.differences as Array<{ path: string }>
    expect(Array.isArray(differences)).toBe(true)
    expect(differences.some(d => d.path === 'extra')).toBe(true)
  })

  it('M-new-2: after clear during restore, a fresh runBootstrapSync starts a new bootstrap rather than absorbing', async () => {
    scripted.setScript(makeScriptedSnapshot('products', 1024).chunks)

    const state = createBootstrapSyncState()
    const deps = makeDeps(mockEngine.engine, coordinator, scripted.transport)

    const releaseRestore = mockEngine.holdRestore()
    const first = runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    await mockEngine.restoreStarted
    clearBootstrapSyncIndex(state, 'products', 0)

    expect(state.inFlight.has('products:0')).toBe(false)

    const second = runBootstrapSync(state, 'products', 0, 'primary-node', deps)
    releaseRestore()

    const firstResult = await first
    const secondResult = await second

    expect(firstResult).toBe(false)
    expect(secondResult).toBe(true)

    expect(scripted.streamCalls.length).toBeGreaterThanOrEqual(2)
    expect(state.completed.has('products:0')).toBe(true)
    expect(mockEngine.engine.listIndexes().find(i => i.name === 'products')).toBeDefined()
  })
})
