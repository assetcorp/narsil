import { describe, expect, it, vi } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import type { WorkerResponse } from '../../workers/protocol'
import { createWorkerExecutor, type WorkerLike } from '../../workers/worker-executor'

interface MockWorker extends WorkerLike {
  lastMessage: unknown
  simulateResponse(response: WorkerResponse): void
}

function createMockWorker(): MockWorker {
  let handler: ((msg: unknown) => void) | null = null

  return {
    lastMessage: null as unknown,
    postMessage(msg: unknown) {
      this.lastMessage = msg
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      if (event === 'message') {
        handler = fn as (msg: unknown) => void
      }
    },
    simulateResponse(response: WorkerResponse) {
      handler?.(response)
    },
  }
}

function swallow(promise: Promise<unknown>) {
  promise.catch(() => {})
}

describe('WorkerExecutor', () => {
  describe('execute', () => {
    it('sends a message and resolves on success response', async () => {
      const worker = createMockWorker()
      const executor = createWorkerExecutor(worker)
      const promise = executor.execute<number>({
        type: 'count',
        indexName: 'products',
        requestId: 'placeholder',
      })

      const sentAction = worker.lastMessage as { requestId: string }
      expect(sentAction).not.toBeNull()

      worker.simulateResponse({
        type: 'success',
        requestId: sentAction.requestId,
        data: 42,
      })

      const result = await promise
      expect(result).toBe(42)
    })

    it('rejects on error response', async () => {
      const worker = createMockWorker()
      const executor = createWorkerExecutor(worker)
      const promise = executor.execute({
        type: 'count',
        indexName: 'products',
        requestId: 'placeholder',
      })

      const sentAction = worker.lastMessage as { requestId: string }
      worker.simulateResponse({
        type: 'error',
        requestId: sentAction.requestId,
        code: ErrorCodes.INDEX_NOT_FOUND,
        message: 'Index "products" does not exist',
      })

      await expect(promise).rejects.toThrow(NarsilError)

      try {
        await promise
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.INDEX_NOT_FOUND)
      }
    })

    it('rejects with WORKER_BUSY when backpressure limit is reached', async () => {
      const worker = createMockWorker()
      const executor = createWorkerExecutor(worker, { backpressureLimit: 2 })

      const first = executor.execute({ type: 'count', indexName: 'a', requestId: 'p1' })
      const second = executor.execute({ type: 'count', indexName: 'b', requestId: 'p2' })
      swallow(first)
      swallow(second)

      const third = executor.execute({ type: 'count', indexName: 'c', requestId: 'p3' })

      await expect(third).rejects.toThrow(NarsilError)
      try {
        await third
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.WORKER_BUSY)
      }
    })

    it('rejects with WORKER_TIMEOUT when no response arrives in time', async () => {
      vi.useFakeTimers()
      try {
        const worker = createMockWorker()
        const executor = createWorkerExecutor(worker, { requestTimeout: 500 })
        const promise = executor.execute({
          type: 'count',
          indexName: 'products',
          requestId: 'placeholder',
        })
        swallow(promise)

        await vi.advanceTimersByTimeAsync(501)

        await expect(promise).rejects.toThrow(NarsilError)
        try {
          await promise
        } catch (e) {
          expect((e as NarsilError).code).toBe(ErrorCodes.WORKER_TIMEOUT)
        }
      } finally {
        vi.useRealTimers()
      }
    })

    it('discards invalid responses', async () => {
      vi.useFakeTimers()
      try {
        const worker = createMockWorker()
        const executor = createWorkerExecutor(worker, { requestTimeout: 1000 })
        const promise = executor.execute({
          type: 'count',
          indexName: 'products',
          requestId: 'placeholder',
        })
        swallow(promise)

        worker.simulateResponse({ type: 'garbage' } as unknown as WorkerResponse)
        worker.simulateResponse(null as unknown as WorkerResponse)
        worker.simulateResponse({ type: 'success', requestId: 'wrong-id', data: 'nope' })

        await vi.advanceTimersByTimeAsync(1001)

        await expect(promise).rejects.toThrow(NarsilError)
        try {
          await promise
        } catch (e) {
          expect((e as NarsilError).code).toBe(ErrorCodes.WORKER_TIMEOUT)
        }
      } finally {
        vi.useRealTimers()
      }
    })

    it('handles multiple concurrent requests with different requestIds', async () => {
      const worker = createMockWorker()
      const executor = createWorkerExecutor(worker)

      const sentIds: string[] = []
      const originalPostMessage = worker.postMessage.bind(worker)
      worker.postMessage = (msg: unknown) => {
        sentIds.push((msg as { requestId: string }).requestId)
        originalPostMessage(msg)
      }

      const p1 = executor.execute<number>({ type: 'count', indexName: 'a', requestId: 'p1' })
      const p2 = executor.execute<number>({ type: 'count', indexName: 'b', requestId: 'p2' })

      expect(sentIds.length).toBe(2)
      expect(sentIds[0]).not.toBe(sentIds[1])

      worker.simulateResponse({ type: 'success', requestId: sentIds[1], data: 200 })
      worker.simulateResponse({ type: 'success', requestId: sentIds[0], data: 100 })

      expect(await p1).toBe(100)
      expect(await p2).toBe(200)
    })

    it('uses addEventListener when on() is not available', async () => {
      let handler: ((msg: unknown) => void) | null = null
      const webWorker: WorkerLike = {
        postMessage(msg: unknown) {
          ;(this as { lastMessage: unknown }).lastMessage = msg
        },
        addEventListener(event: string, fn: (...args: unknown[]) => void) {
          if (event === 'message') {
            handler = fn as (msg: unknown) => void
          }
        },
      }

      const executor = createWorkerExecutor(webWorker)
      const promise = executor.execute<number>({
        type: 'count',
        indexName: 'products',
        requestId: 'placeholder',
      })

      const sentAction = (webWorker as unknown as { lastMessage: { requestId: string } }).lastMessage
      handler?.({ data: { type: 'success', requestId: sentAction.requestId, data: 7 } })

      expect(await promise).toBe(7)
    })
  })

  describe('shutdown', () => {
    it('clears all pending requests on shutdown', async () => {
      const worker = createMockWorker()
      const executor = createWorkerExecutor(worker, { requestTimeout: 10_000 })

      const pending = executor.execute({ type: 'count', indexName: 'a', requestId: 'p1' })
      swallow(pending)

      const sentActions: { requestId: string }[] = []
      const originalPostMessage = worker.postMessage.bind(worker)
      worker.postMessage = (msg: unknown) => {
        sentActions.push(msg as { requestId: string })
        originalPostMessage(msg)
      }

      const shutdownPromise = executor.shutdown()

      const shutdownAction = sentActions[0]
      worker.simulateResponse({
        type: 'success',
        requestId: shutdownAction.requestId,
        data: undefined,
      })

      await shutdownPromise

      await expect(pending).rejects.toThrow(NarsilError)
      try {
        await pending
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.WORKER_CRASHED)
      }
    })

    it('rejects with WORKER_TIMEOUT if shutdown response never arrives', async () => {
      vi.useFakeTimers()
      try {
        const worker = createMockWorker()
        const executor = createWorkerExecutor(worker)

        const shutdownPromise = executor.shutdown()
        swallow(shutdownPromise)

        await vi.advanceTimersByTimeAsync(5001)

        await expect(shutdownPromise).rejects.toThrow(NarsilError)
        try {
          await shutdownPromise
        } catch (e) {
          expect((e as NarsilError).code).toBe(ErrorCodes.WORKER_TIMEOUT)
        }
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
