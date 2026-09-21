import { getHeapStatistics } from 'node:v8'
import { describe, expect, it } from 'vitest'
import { IDLE_HEAP_CLEANUP_CHECK_MS, IDLE_HEAP_CLEANUP_QUIET_CHECKS } from '../../runtime/constants'
import { startIdleHeapCleanup } from '../../runtime/idle-heap-cleanup'

const MB = 1024 * 1024

function fillTheHeapWithGarbage(): void {
  let kept: Array<{ id: string; words: string[] }> = []
  for (let round = 0; round < 20; round++) {
    kept = []
    for (let i = 0; i < 200_000; i++) kept.push({ id: `d${i}`, words: [`term${i}`, `term${i + 1}`] })
  }
  if (kept.length === 0) throw new Error('unreachable')
}

describe('idle heap cleanup on a real thread', () => {
  it('returns the heap pages of a thread that went quiet', async () => {
    fillTheHeapWithGarbage()
    const heldWhileBusy = getHeapStatistics().total_physical_size
    expect(heldWhileBusy).toBeGreaterThan(100 * MB)

    const stop = startIdleHeapCleanup()
    try {
      const quietMs = IDLE_HEAP_CLEANUP_CHECK_MS * (IDLE_HEAP_CLEANUP_QUIET_CHECKS + 2)
      await new Promise(resolve => setTimeout(resolve, quietMs))
    } finally {
      stop()
    }

    expect(getHeapStatistics().total_physical_size).toBeLessThan(heldWhileBusy / 2)
  }, 15_000)
})
