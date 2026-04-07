import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('WorkerPool: worker count resolution', () => {
  it('uses the explicitly provided count', () => {
    const pool = createWorkerPool({
      count: 3,
      workerFactory: () => createMockExecutor(),
    })
    expect(pool.workerCount).toBe(3)
  })

  it('clamps resolved count to a minimum of 2', () => {
    const pool = createWorkerPool({
      count: undefined,
      workerFactory: () => createMockExecutor(),
    })
    expect(pool.workerCount).toBeGreaterThanOrEqual(2)
  })

  it('clamps resolved count to a maximum of 8', () => {
    const pool = createWorkerPool({
      count: undefined,
      workerFactory: () => createMockExecutor(),
    })
    expect(pool.workerCount).toBeLessThanOrEqual(8)
  })
})

describe('WorkerPool: lazy initialization', () => {
  it('does not create workers until addIndex is called', () => {
    const factoryCalls: number[] = []
    const pool = createWorkerPool({
      count: 4,
      workerFactory: (id: number) => {
        factoryCalls.push(id)
        return createMockExecutor()
      },
    })

    expect(factoryCalls).toHaveLength(0)
    expect(pool.getMemoryStats()).toEqual([])
  })

  it('creates a worker on demand when addIndex is called', () => {
    const factoryCalls: number[] = []
    const pool = createWorkerPool({
      count: 4,
      workerFactory: (id: number) => {
        factoryCalls.push(id)
        return createMockExecutor()
      },
    })

    pool.addIndex('products')
    expect(factoryCalls.length).toBeGreaterThanOrEqual(1)
  })
})

describe('WorkerPool: index lifecycle edge cases', () => {
  it('throws WORKER_CRASHED when addIndex is called after shutdown', async () => {
    const pool = createWorkerPool({
      count: 2,
      workerFactory: () => createMockExecutor(),
    })
    await pool.shutdown()
    expect(() => pool.addIndex('products')).toThrow(NarsilError)
  })

  it('allows re-adding an index after removal', () => {
    const pool = createWorkerPool({
      count: 4,
      workerFactory: () => createMockExecutor(),
    })
    pool.addIndex('products')
    pool.removeIndex('products')
    pool.addIndex('products')
    expect(pool.getExecutor('products')).toBeDefined()
  })

  it('throws INDEX_NOT_FOUND for an unknown index', () => {
    const pool = createWorkerPool({
      count: 2,
      workerFactory: () => createMockExecutor(),
    })
    expect(() => pool.getExecutor('nonexistent')).toThrow(NarsilError)
  })
})

describe('WorkerPool: addIndexToAll', () => {
  it('creates workers in every slot', () => {
    const factoryCalls: number[] = []
    const pool = createWorkerPool({
      count: 3,
      workerFactory: (id: number) => {
        factoryCalls.push(id)
        return createMockExecutor()
      },
    })
    pool.addIndexToAll('global-index')
    expect(factoryCalls).toHaveLength(3)
    expect(factoryCalls).toContain(0)
    expect(factoryCalls).toContain(1)
    expect(factoryCalls).toContain(2)
  })

  it('throws WORKER_CRASHED when called after shutdown', async () => {
    const pool = createWorkerPool({
      count: 2,
      workerFactory: () => createMockExecutor(),
    })
    await pool.shutdown()
    expect(() => pool.addIndexToAll('products')).toThrow(NarsilError)
  })
})

describe('WorkerPool: getAllExecutors', () => {
  it('returns all active executors', () => {
    const pool = createWorkerPool({
      count: 4,
      workerFactory: () => createMockExecutor(),
    })
    pool.addIndexToAll('global')
    const all = pool.getAllExecutors()
    expect(all).toHaveLength(4)
  })

  it('returns an empty array when no workers have been created', () => {
    const pool = createWorkerPool({
      count: 4,
      workerFactory: () => createMockExecutor(),
    })
    expect(pool.getAllExecutors()).toEqual([])
  })
})

describe('WorkerPool: shutdown with slow worker', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves even when an executor shutdown never completes', async () => {
    vi.useFakeTimers()

    const pool = createWorkerPool({
      count: 2,
      workerFactory: () => ({
        async execute<T>(): Promise<T> {
          return undefined as T
        },
        shutdown(): Promise<void> {
          return new Promise(() => {})
        },
      }),
    })

    pool.addIndex('products')

    const shutdownPromise = pool.shutdown()
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(shutdownPromise).resolves.toBeUndefined()
  })
})

describe('WorkerPool: getMemoryStats', () => {
  it('returns stats with correct workerId for each spawned worker', () => {
    const pool = createWorkerPool({
      count: 4,
      workerFactory: () => createMockExecutor(),
    })
    pool.addIndexToAll('products')
    const stats = pool.getMemoryStats()

    expect(stats).toHaveLength(4)
    const workerIds = stats.map(s => s.workerId)
    expect(workerIds).toContain(0)
    expect(workerIds).toContain(1)
    expect(workerIds).toContain(2)
    expect(workerIds).toContain(3)

    for (const entry of stats) {
      expect(typeof entry.heapUsed).toBe('number')
      expect(typeof entry.heapTotal).toBe('number')
      expect(typeof entry.external).toBe('number')
    }
  })
})
