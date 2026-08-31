import { describe, expect, it, vi } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import type { WorkerResponse } from '../../workers/protocol'
import { createWorkerExecutor, type WorkerLike } from '../../workers/worker-executor'

interface MockWorker extends WorkerLike {
  lastMessage: unknown
  simulateResponse(response: WorkerResponse): void
  simulateError(error: Error): void
  simulateExit(code: number): void
}

function createMockWorker(): MockWorker {
  const handlers = new Map<string, (...args: unknown[]) => void>()

  return {
    lastMessage: null as unknown,
    postMessage(msg: unknown) {
      this.lastMessage = msg
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, fn)
    },
    simulateResponse(response: WorkerResponse) {
      handlers.get('message')?.(response)
    },
    simulateError(error: Error) {
      handlers.get('error')?.(error)
    },
    simulateExit(code: number) {
      handlers.get('exit')?.(code)
    },
  }
}

interface MockWebWorker extends WorkerLike {
  lastMessage: unknown
  simulateResponse(response: WorkerResponse): void
  simulateErrorEvent(event: { message?: string; error?: unknown }): void
}

function createMockWebWorker(): MockWebWorker {
  const handlers = new Map<string, (...args: unknown[]) => void>()

  return {
    lastMessage: null as unknown,
    postMessage(msg: unknown) {
      this.lastMessage = msg
    },
    addEventListener(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, fn)
    },
    simulateResponse(response: WorkerResponse) {
      handlers.get('message')?.({ data: response })
    },
    simulateErrorEvent(event: { message?: string; error?: unknown }) {
      handlers.get('error')?.(event)
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
      const handlerRef: { value: ((msg: unknown) => void) | null } = { value: null }
      const webWorker: WorkerLike = {
        postMessage(msg: unknown) {
          ;(this as unknown as { lastMessage: unknown }).lastMessage = msg
        },
        addEventListener(event: string, fn: (...args: unknown[]) => void) {
          if (event === 'message') {
            handlerRef.value = fn as (msg: unknown) => void
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
      if (!handlerRef.value) throw new Error('expected handler to be registered')
      handlerRef.value({ data: { type: 'success', requestId: sentAction.requestId, data: 7 } })

      expect(await promise).toBe(7)
    })
  })

  describe('worker death', () => {
    it('rejects every pending request with WORKER_CRASHED when the worker errors', async () => {
      const worker = createMockWorker()
      const onDeath = vi.fn()
      const executor = createWorkerExecutor(worker, { onDeath })

      const pending = executor.execute({ type: 'count', indexName: 'a', requestId: 'p1' })
      swallow(pending)

      worker.simulateError(new Error('segfault'))

      await expect(pending).rejects.toMatchObject({ code: ErrorCodes.WORKER_CRASHED })
      expect(onDeath).toHaveBeenCalledTimes(1)
    })

    it('rejects every pending request with WORKER_CRASHED when the worker exits', async () => {
      const worker = createMockWorker()
      const onDeath = vi.fn()
      const executor = createWorkerExecutor(worker, { onDeath })

      const pending = executor.execute({ type: 'count', indexName: 'a', requestId: 'p1' })
      swallow(pending)

      worker.simulateExit(1)

      await expect(pending).rejects.toMatchObject({ code: ErrorCodes.WORKER_CRASHED })
      expect(onDeath).toHaveBeenCalledTimes(1)
    })

    it('reports the death once when error and exit both fire', async () => {
      const worker = createMockWorker()
      const onDeath = vi.fn()
      const executor = createWorkerExecutor(worker, { onDeath })
      swallow(executor.execute({ type: 'count', indexName: 'a', requestId: 'p1' }))

      worker.simulateError(new Error('segfault'))
      worker.simulateExit(1)

      expect(onDeath).toHaveBeenCalledTimes(1)
    })

    it('rejects a request sent after the worker died without waiting for a timeout', async () => {
      const worker = createMockWorker()
      const executor = createWorkerExecutor(worker)

      worker.simulateExit(1)

      await expect(executor.execute({ type: 'count', indexName: 'a', requestId: 'p1' })).rejects.toMatchObject({
        code: ErrorCodes.WORKER_CRASHED,
      })
    })

    it('treats an exit during shutdown as a shutdown, keeping onDeath silent', async () => {
      const worker = createMockWorker()
      const onDeath = vi.fn()
      const executor = createWorkerExecutor(worker, { onDeath })

      const shutdownPromise = executor.shutdown()
      swallow(shutdownPromise)
      worker.simulateExit(0)

      await expect(shutdownPromise).rejects.toMatchObject({ code: ErrorCodes.WORKER_CRASHED })
      expect(onDeath).not.toHaveBeenCalled()
    })

    it('retires a worker that leaves three consecutive requests unanswered', async () => {
      vi.useFakeTimers()
      try {
        const worker = createMockWebWorker()
        const onDeath = vi.fn()
        const executor = createWorkerExecutor(worker, { requestTimeout: 500, onDeath })

        let last: Promise<unknown> = Promise.resolve()
        for (let attempt = 0; attempt < 3; attempt += 1) {
          last = executor.execute({ type: 'count', indexName: 'a', requestId: 'p1' })
          swallow(last)
          await vi.advanceTimersByTimeAsync(501)
        }

        await expect(last).rejects.toMatchObject({ code: ErrorCodes.WORKER_TIMEOUT })
        expect(onDeath).toHaveBeenCalledTimes(1)
        await expect(executor.execute({ type: 'count', indexName: 'a', requestId: 'p2' })).rejects.toMatchObject({
          code: ErrorCodes.WORKER_CRASHED,
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps a slow worker when a late answer arrives between timeouts', async () => {
      vi.useFakeTimers()
      try {
        const worker = createMockWebWorker()
        const onDeath = vi.fn()
        const executor = createWorkerExecutor(worker, { requestTimeout: 500, onDeath })

        for (let attempt = 0; attempt < 5; attempt += 1) {
          swallow(executor.execute({ type: 'count', indexName: 'a', requestId: 'p1' }))
          await vi.advanceTimersByTimeAsync(501)
          const sent = worker.lastMessage as { requestId: string }
          worker.simulateResponse({ type: 'success', requestId: sent.requestId, data: 1 })
        }

        expect(onDeath).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('rejects every pending request with WORKER_CRASHED when a browser worker reports an error', async () => {
      const worker = createMockWebWorker()
      const onDeath = vi.fn()
      const executor = createWorkerExecutor(worker, { onDeath })

      const pending = executor.execute({ type: 'count', indexName: 'a', requestId: 'p1' })
      swallow(pending)

      worker.simulateErrorEvent({ message: 'Failed to load the worker entry point' })

      await expect(pending).rejects.toMatchObject({ code: ErrorCodes.WORKER_CRASHED })
      expect(onDeath).toHaveBeenCalledTimes(1)
    })

    it('carries the browser error message into the failure it raises', async () => {
      const worker = createMockWebWorker()
      const executor = createWorkerExecutor(worker)

      const pending = executor.execute({ type: 'count', indexName: 'a', requestId: 'p1' })
      swallow(pending)

      worker.simulateErrorEvent({ message: 'Failed to load the worker entry point' })

      await expect(pending).rejects.toThrow('Failed to load the worker entry point')
    })

    it('reads the error a browser event carries when it holds one', async () => {
      const worker = createMockWebWorker()
      const onDeath = vi.fn()
      createWorkerExecutor(worker, { onDeath })

      worker.simulateErrorEvent({ message: '', error: new Error('the module threw while loading') })

      expect(onDeath).toHaveBeenCalledTimes(1)
      expect((onDeath.mock.calls[0][0] as Error).message).toBe('the module threw while loading')
    })

    it('rejects a request sent after a browser worker error without waiting for a timeout', async () => {
      const worker = createMockWebWorker()
      const executor = createWorkerExecutor(worker)

      worker.simulateErrorEvent({ message: 'Failed to load the worker entry point' })

      await expect(executor.execute({ type: 'count', indexName: 'a', requestId: 'p1' })).rejects.toMatchObject({
        code: ErrorCodes.WORKER_CRASHED,
      })
    })

    it('treats a browser worker error during shutdown as a shutdown, keeping onDeath silent', async () => {
      const worker = createMockWebWorker()
      const onDeath = vi.fn()
      const executor = createWorkerExecutor(worker, { onDeath })

      const shutdownPromise = executor.shutdown()
      swallow(shutdownPromise)
      worker.simulateErrorEvent({ message: 'The page terminated the worker' })

      await expect(shutdownPromise).rejects.toMatchObject({ code: ErrorCodes.WORKER_CRASHED })
      expect(onDeath).not.toHaveBeenCalled()
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
