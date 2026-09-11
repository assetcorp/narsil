import { describe, expect, it, vi } from 'vitest'

const hostMemory = vi.hoisted(() => ({ bytes: null as number | null, heapLimitBytes: null as number | null }))

vi.mock('#platform/heap-statistics', () => ({
  readHostMemoryBytes: () => hostMemory.bytes,
  readHeapStatistics: () =>
    hostMemory.heapLimitBytes === null ? null : { usedBytes: 0, limitBytes: hostMemory.heapLimitBytes },
}))

import { workerResourceLimits } from '../../workers/resource-limits'

const GIGABYTE = 1024 * 1024 * 1024

describe('worker heap limits', () => {
  it('splits half the host memory equally between the workers of a pool', () => {
    hostMemory.bytes = 8 * GIGABYTE
    hostMemory.heapLimitBytes = null

    expect(workerResourceLimits(8).maxOldGenerationSizeMb).toBe(512)
    expect(workerResourceLimits(4).maxOldGenerationSizeMb).toBe(1024)
    expect(workerResourceLimits(2).maxOldGenerationSizeMb).toBe(2048)
  })

  it('keeps every worker above the floor on a host too small to divide', () => {
    hostMemory.bytes = GIGABYTE
    hostMemory.heapLimitBytes = null

    expect(workerResourceLimits(8).maxOldGenerationSizeMb).toBe(512)
  })

  it('divides the heap the runtime reports where the host reports no memory of its own', () => {
    hostMemory.bytes = null
    hostMemory.heapLimitBytes = 16 * GIGABYTE

    expect(workerResourceLimits(8).maxOldGenerationSizeMb).toBe(1024)
  })

  it('leaves the old generation to the runtime where neither figure is available', () => {
    hostMemory.bytes = null
    hostMemory.heapLimitBytes = null

    const limits = workerResourceLimits(8)
    expect(limits.maxOldGenerationSizeMb).toBeUndefined()
    expect(limits.maxYoungGenerationSizeMb).toBe(24)
  })

  it('assumes the largest pool where the caller names no worker count', () => {
    hostMemory.bytes = 8 * GIGABYTE
    hostMemory.heapLimitBytes = null

    expect(workerResourceLimits().maxOldGenerationSizeMb).toBe(512)
    expect(workerResourceLimits(0).maxOldGenerationSizeMb).toBe(512)
  })
})
