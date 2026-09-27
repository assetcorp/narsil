import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Executor } from '../../workers/executor'
import { createWorkerPool } from '../../workers/pool'

function promptlyExitingExecutor(): Executor {
  return {
    async execute<T>(): Promise<T> {
      return undefined as T
    },
    async shutdown() {},
  }
}

describe('a worker pool that shuts down', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves no timer behind once every thread exits, so the process can exit at once', async () => {
    vi.useFakeTimers()
    const pool = createWorkerPool({ count: 3, workerFactory: () => promptlyExitingExecutor() })
    pool.addIndex('tickets')
    pool.getExecutor('tickets')

    await pool.shutdown()

    expect(vi.getTimerCount()).toBe(0)
  })
})
