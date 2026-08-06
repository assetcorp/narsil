import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dropExistingIndex } from '../../../../distribution/cluster-node/bootstrap-restore'
import {
  clearBootstrapSyncIndex,
  createBootstrapSyncState,
  runBootstrapSync,
} from '../../../../distribution/cluster-node/bootstrap-sync'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
import { ErrorCodes, NarsilError } from '../../../../errors'
import type { Narsil } from '../../../../narsil'
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
    coordinator = makeMockCoordinator({ title: 'text' })
    scripted = makeScriptedTransport()
  })

  it('M-A: clear fired during restore drops the restored index so engine state matches onError', async () => {
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
    expect(mockEngine.engine.listIndexes().find(i => i.name === 'products')).toBeUndefined()

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

  it('L-C: a restored schema that disagrees with the coordinator schema is dropped and reported', async () => {
    mockEngine = makeMockEngine({ statsSchema: { title: 'text', extra: 'number' } })
    scripted.setScript(makeScriptedSnapshot('products', 256).chunks)

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

  it('I-new-1: dropRestoredIndexQuietly surfaces cleanup failure via onError with SNAPSHOT_SYNC_RESTORE_CLEANUP_FAILED', async () => {
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

    scripted.setScript(makeScriptedSnapshot('products', 256).chunks)

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
