import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeInfo } from '../../../runtime/detect'

vi.mock('../../../runtime/detect', () => ({
  detectRuntime: vi.fn<() => RuntimeInfo>(() => ({
    runtime: 'node',
    supportsWorkerThreads: false,
    supportsWebWorkers: false,
    supportsFileSystem: true,
    supportsIndexedDB: false,
    supportsBroadcastChannel: false,
    cpuCount: 4,
  })),
}))

vi.mock('node:worker_threads', () => {
  const WorkerMock = vi.fn()
  return { Worker: WorkerMock }
})

import { detectRuntime } from '../../../runtime/detect'
import type { HNSWConfig } from '../../../vector/hnsw'
import { dispatchWorkerBuild, resetWorkerAvailabilityCache } from '../../../vector/hnsw-worker-dispatch'
import {
  buildVectorData,
  createFakeNodeWorker,
  createNodeRuntime,
  createNoWorkerRuntime,
  sampleConfig,
  sampleGraph,
  setupNodeWorkerAutoReply,
  setupNodeWorkerMock,
  testDim,
  testDocIds,
  testVectors,
} from './fixtures'

const mockedDetectRuntime = vi.mocked(detectRuntime)

describe('dispatchWorkerBuild', () => {
  beforeEach(() => {
    resetWorkerAvailabilityCache()
    vi.clearAllMocks()
  })

  it('returns no-workers when runtime has no worker support', async () => {
    mockedDetectRuntime.mockReturnValue(createNoWorkerRuntime())

    const result = await dispatchWorkerBuild(testDocIds, testVectors, testDim, sampleConfig)

    expect(result).toEqual({
      ok: false,
      reason: 'no-workers',
      message: 'No worker thread support available in the current runtime',
    })
  })

  it('returns no-workers when Worker constructor throws', async () => {
    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const workerThreads = await import('node:worker_threads')
    const WorkerCtor = vi.mocked(workerThreads.Worker)
    WorkerCtor.mockImplementation(function workerCtor() {
      throw new Error('cannot spawn')
    })

    const result = await dispatchWorkerBuild(testDocIds, testVectors, testDim, sampleConfig)

    expect(result).toEqual({
      ok: false,
      reason: 'no-workers',
      message: 'No worker thread support available in the current runtime',
    })
  })

  it('returns success with graph when worker responds with success message', async () => {
    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const fake = createFakeNodeWorker()
    await setupNodeWorkerMock(fake)
    setupNodeWorkerAutoReply(fake, { type: 'success', graph: sampleGraph })

    const result = await dispatchWorkerBuild(testDocIds, testVectors, testDim, sampleConfig)

    expect(result).toEqual({ ok: true, graph: sampleGraph })
  })

  it('returns build-error when worker responds with error message', async () => {
    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const fake = createFakeNodeWorker()
    await setupNodeWorkerMock(fake)
    setupNodeWorkerAutoReply(fake, { type: 'error', message: 'dimension mismatch' })

    const result = await dispatchWorkerBuild(testDocIds, testVectors, testDim, sampleConfig)

    expect(result).toEqual({
      ok: false,
      reason: 'build-error',
      message: 'dimension mismatch',
    })
  })

  it('returns timeout when worker does not respond within timeoutMs', async () => {
    vi.useFakeTimers()

    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const fake = createFakeNodeWorker()
    await setupNodeWorkerMock(fake)

    const timeoutMs = 5_000
    const promise = dispatchWorkerBuild(testDocIds, testVectors, testDim, sampleConfig, timeoutMs)

    await vi.advanceTimersByTimeAsync(timeoutMs + 1)

    const result = await promise
    expect(result).toEqual({
      ok: false,
      reason: 'timeout',
      message: `HNSW build timed out after ${timeoutMs}ms`,
    })

    vi.useRealTimers()
  })

  it('terminates worker after success response', async () => {
    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const fake = createFakeNodeWorker()
    await setupNodeWorkerMock(fake)
    setupNodeWorkerAutoReply(fake, { type: 'success', graph: sampleGraph })

    await dispatchWorkerBuild(testDocIds, testVectors, testDim, sampleConfig)

    expect(fake.worker.terminate).toHaveBeenCalledOnce()
  })

  it('terminates worker after error response', async () => {
    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const fake = createFakeNodeWorker()
    await setupNodeWorkerMock(fake)
    setupNodeWorkerAutoReply(fake, { type: 'error', message: 'build failed' })

    await dispatchWorkerBuild(testDocIds, testVectors, testDim, sampleConfig)

    expect(fake.worker.terminate).toHaveBeenCalledOnce()
  })

  it('terminates worker after timeout', async () => {
    vi.useFakeTimers()

    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const fake = createFakeNodeWorker()
    await setupNodeWorkerMock(fake)

    const timeoutMs = 3_000
    const promise = dispatchWorkerBuild(testDocIds, testVectors, testDim, sampleConfig, timeoutMs)

    await vi.advanceTimersByTimeAsync(timeoutMs + 1)
    await promise

    expect(fake.worker.terminate).toHaveBeenCalledOnce()

    vi.useRealTimers()
  })

  it('creates a copy of the buffer when skipCopy is false', async () => {
    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const fake = createFakeNodeWorker()
    await setupNodeWorkerMock(fake)

    const originalBuffer = new Float32Array([1, 2, 3, 4])

    let sentRequest: unknown = null
    fake.worker.postMessage.mockImplementation((msg: unknown) => {
      sentRequest = msg
      queueMicrotask(() => fake.sendMessage({ type: 'success', graph: sampleGraph }))
    })

    await dispatchWorkerBuild(testDocIds, originalBuffer, testDim, sampleConfig)

    const request = sentRequest as { vectorData: Float32Array }
    expect(request.vectorData).not.toBe(originalBuffer)
    expect(request.vectorData.buffer).not.toBe(originalBuffer.buffer)
    expect(Array.from(request.vectorData)).toEqual(Array.from(originalBuffer))
  })

  it('sends the original buffer when skipCopy is true', async () => {
    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const fake = createFakeNodeWorker()
    await setupNodeWorkerMock(fake)

    const originalBuffer = new Float32Array([1, 2, 3, 4])

    let sentRequest: unknown = null
    fake.worker.postMessage.mockImplementation((msg: unknown) => {
      sentRequest = msg
      queueMicrotask(() => fake.sendMessage({ type: 'success', graph: sampleGraph }))
    })

    await dispatchWorkerBuild(testDocIds, originalBuffer, testDim, sampleConfig, undefined, true)

    const request = sentRequest as { vectorData: Float32Array }
    expect(request.vectorData).toBe(originalBuffer)
  })

  it('passes the buffer in the transfer array of postMessage', async () => {
    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const fake = createFakeNodeWorker()
    await setupNodeWorkerMock(fake)
    setupNodeWorkerAutoReply(fake, { type: 'success', graph: sampleGraph })

    const vectorData = new Float32Array([1, 2, 3, 4])

    await dispatchWorkerBuild(testDocIds, vectorData, testDim, sampleConfig)

    const postMessageCall = fake.worker.postMessage.mock.calls[0] as [{ vectorData: Float32Array }, ArrayBuffer[]]
    const transferredBuffers = postMessageCall[1]
    expect(transferredBuffers).toHaveLength(1)
    expect(transferredBuffers[0]).toBe(postMessageCall[0].vectorData.buffer)
  })

  it('returns spawn-error when postMessage throws', async () => {
    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const fake = createFakeNodeWorker()
    await setupNodeWorkerMock(fake)

    fake.worker.postMessage.mockImplementation(() => {
      throw new Error('buffer transfer failed')
    })

    const result = await dispatchWorkerBuild(testDocIds, testVectors, testDim, sampleConfig)

    expect(result).toEqual({
      ok: false,
      reason: 'spawn-error',
      message: 'buffer transfer failed',
    })
  })

  it('ignores messages received after the promise has settled', async () => {
    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const fake = createFakeNodeWorker()
    await setupNodeWorkerMock(fake)
    setupNodeWorkerAutoReply(fake, { type: 'success', graph: sampleGraph })

    const result = await dispatchWorkerBuild(testDocIds, testVectors, testDim, sampleConfig)

    fake.sendMessage({ type: 'error', message: 'late error' })

    expect(result).toEqual({ ok: true, graph: sampleGraph })
  })

  it('uses custom timeoutMs instead of default', async () => {
    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const fake = createFakeNodeWorker()
    await setupNodeWorkerMock(fake)
    setupNodeWorkerAutoReply(fake, { type: 'success', graph: sampleGraph })

    const customTimeout = 500
    const result = await dispatchWorkerBuild(testDocIds, testVectors, testDim, sampleConfig, customTimeout)

    expect(result).toEqual({ ok: true, graph: sampleGraph })
  })

  it('times out at custom timeoutMs value', async () => {
    vi.useFakeTimers()

    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const fake = createFakeNodeWorker()
    await setupNodeWorkerMock(fake)

    const customTimeout = 500
    const promise = dispatchWorkerBuild(testDocIds, testVectors, testDim, sampleConfig, customTimeout)

    await vi.advanceTimersByTimeAsync(501)

    const result = await promise
    expect(result).toEqual({
      ok: false,
      reason: 'timeout',
      message: `HNSW build timed out after ${customTimeout}ms`,
    })

    vi.useRealTimers()
  })

  it('passes correct request structure to worker via postMessage', async () => {
    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const fake = createFakeNodeWorker()
    await setupNodeWorkerMock(fake)
    setupNodeWorkerAutoReply(fake, { type: 'success', graph: sampleGraph })

    const docIds = ['doc-1', 'doc-2']
    const vectorData = buildVectorData(2, 4)
    const dimension = 4

    await dispatchWorkerBuild(docIds, vectorData, dimension, sampleConfig)

    const postMessageCall = fake.worker.postMessage.mock.calls[0] as [
      { type: string; docIds: string[]; dimension: number; config: HNSWConfig },
      ArrayBuffer[],
    ]
    const sentRequest = postMessageCall[0]
    expect(sentRequest.type).toBe('build-binary')
    expect(sentRequest.docIds).toEqual(docIds)
    expect(sentRequest.dimension).toBe(dimension)
    expect(sentRequest.config).toEqual(sampleConfig)
  })
})
