import { beforeEach, describe, expect, it } from 'vitest'
import { NarsilError } from '../../errors'
import type { Executor } from '../../workers/executor'
import { createWorkerPool, type WorkerPool } from '../../workers/pool'
import type { WorkerAction } from '../../workers/protocol'

function createMockExecutor(): Executor & { shutdownCalled: boolean } {
  return {
    shutdownCalled: false,
    async execute<T>(_action: WorkerAction): Promise<T> {
      return undefined as T
    },
    async shutdown() {
      this.shutdownCalled = true
    },
  }
}

describe('WorkerPool', () => {
  const executors: Array<Executor & { shutdownCalled: boolean }> = []
  let pool: WorkerPool

  beforeEach(() => {
    executors.length = 0
    pool = createWorkerPool({
      count: 4,
      workerFactory: (workerId: number) => {
        const executor = createMockExecutor()
        executors[workerId] = executor
        return executor
      },
    })
  })

  describe('addIndex and getExecutor', () => {
    it('returns an executor for an added index', () => {
      pool.addIndex('products')
      const executor = pool.getExecutor('products')
      expect(executor).toBeDefined()
    })

    it('maps the same index to the same worker on repeated calls', () => {
      pool.addIndex('products')
      const first = pool.getExecutor('products')
      const second = pool.getExecutor('products')
      expect(first).toBe(second)
    })

    it('maps different indexes to potentially different workers', () => {
      pool.addIndex('products')
      pool.addIndex('users')
      pool.addIndex('orders')
      pool.addIndex('inventory')

      const executorSet = new Set([
        pool.getExecutor('products'),
        pool.getExecutor('users'),
        pool.getExecutor('orders'),
        pool.getExecutor('inventory'),
      ])

      expect(executorSet.size).toBeGreaterThanOrEqual(1)
    })

    it('throws INDEX_NOT_FOUND when getting executor for an unregistered index', () => {
      expect(() => pool.getExecutor('ghost')).toThrow(NarsilError)
    })

    it('is idempotent when adding the same index twice', () => {
      pool.addIndex('products')
      pool.addIndex('products')
      const executor = pool.getExecutor('products')
      expect(executor).toBeDefined()
    })
  })

  describe('removeIndex', () => {
    it('removes an index so getExecutor throws afterwards', () => {
      pool.addIndex('products')
      pool.removeIndex('products')
      expect(() => pool.getExecutor('products')).toThrow(NarsilError)
    })

    it('does nothing when removing a nonexistent index', () => {
      expect(() => pool.removeIndex('ghost')).not.toThrow()
    })
  })

  describe('getMemoryStats', () => {
    it('returns stats for spawned workers', () => {
      pool.addIndex('products')
      pool.addIndex('users')

      const stats = pool.getMemoryStats()
      expect(Array.isArray(stats)).toBe(true)
      for (const entry of stats) {
        expect(entry).toHaveProperty('workerId')
        expect(entry).toHaveProperty('heapUsed')
        expect(entry).toHaveProperty('heapTotal')
        expect(entry).toHaveProperty('external')
      }
    })

    it('returns an empty array when no workers have been spawned', () => {
      const emptyPool = createWorkerPool({
        count: 2,
        workerFactory: () => createMockExecutor(),
      })
      expect(emptyPool.getMemoryStats()).toEqual([])
    })
  })

  describe('shutdown', () => {
    it('calls shutdown on all active executors', async () => {
      pool.addIndex('products')
      pool.addIndex('users')
      pool.addIndex('orders')

      await pool.shutdown()

      const activeExecutors = executors.filter(Boolean)
      expect(activeExecutors.length).toBeGreaterThan(0)
      for (const executor of activeExecutors) {
        expect(executor.shutdownCalled).toBe(true)
      }
    })

    it('prevents addIndex after shutdown', async () => {
      await pool.shutdown()
      expect(() => pool.addIndex('products')).toThrow(NarsilError)
    })

    it('prevents getExecutor after shutdown', async () => {
      pool.addIndex('products')
      await pool.shutdown()
      expect(() => pool.getExecutor('products')).toThrow(NarsilError)
    })

    it('is safe to call multiple times', async () => {
      pool.addIndex('products')
      await pool.shutdown()
      await pool.shutdown()
    })

    it('handles executor shutdown failures gracefully', async () => {
      const failPool = createWorkerPool({
        count: 2,
        workerFactory: () => ({
          async execute<T>(): Promise<T> {
            return undefined as T
          },
          async shutdown() {
            throw new Error('crash')
          },
        }),
      })

      failPool.addIndex('products')
      await expect(failPool.shutdown()).resolves.toBeUndefined()
    })
  })
})
