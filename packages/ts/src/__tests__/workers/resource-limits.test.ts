import { describe, expect, it, vi } from 'vitest'

const hostMemory = vi.hoisted(() => ({ bytes: null as number | null, heapLimitBytes: null as number | null }))
const pool = vi.hoisted(() => ({ requestThreads: 7, workers: 7 }))

vi.mock('#platform/heap-statistics', () => ({
  readHostMemoryBytes: () => hostMemory.bytes,
  readHeapStatistics: () =>
    hostMemory.heapLimitBytes === null ? null : { usedBytes: 0, limitBytes: hostMemory.heapLimitBytes },
}))

vi.mock('../../workers/pool', () => ({
  resolveRequestThreadCount: () => pool.requestThreads,
  resolveWorkerCount: () => pool.workers,
  splitWorkerBudget: (total: number) => ({ keyword: Math.ceil(total / 2), vector: total - Math.ceil(total / 2) }),
}))

import { workerResourceLimits } from '../../workers/resource-limits'

const GIGABYTE = 1024 * 1024 * 1024

describe('worker heap limits', () => {
  it('divides half the host memory between every thread the engine starts, counting both pools', () => {
    hostMemory.bytes = 40 * GIGABYTE
    hostMemory.heapLimitBytes = null
    pool.requestThreads = 7
    pool.workers = 7

    expect(workerResourceLimits().maxOldGenerationSizeMb).toBe(2048)
  })

  it('keeps every worker above the floor on a host too small to divide', () => {
    hostMemory.bytes = GIGABYTE
    hostMemory.heapLimitBytes = null

    expect(workerResourceLimits().maxOldGenerationSizeMb).toBe(512)
  })

  it('divides the heap the runtime reports where the host reports no memory of its own', () => {
    hostMemory.bytes = null
    hostMemory.heapLimitBytes = 40 * GIGABYTE

    expect(workerResourceLimits().maxOldGenerationSizeMb).toBe(2048)
  })

  it('leaves the old generation to the runtime where neither figure is available', () => {
    hostMemory.bytes = null
    hostMemory.heapLimitBytes = null

    const limits = workerResourceLimits()
    expect(limits.maxOldGenerationSizeMb).toBeUndefined()
    expect(limits.maxYoungGenerationSizeMb).toBe(24)
  })
})
