import { getHeapStatistics } from 'node:v8'
import { describe, expect, it } from 'vitest'
import { IDLE_HEAP_CLEANUP_CHECK_MS, IDLE_HEAP_CLEANUP_QUIET_CHECKS } from '../../runtime/constants'
import { startIdleHeapCleanup } from '../../runtime/idle-heap-cleanup'

const MB = 1024 * 1024
const GROWN_HEAP_BYTES = 64 * MB
const MAX_FILL_ROUNDS = 100

function growHeapPast(target: number): number {
  let kept: Array<{ id: string; words: string[] }> = []
  let held = getHeapStatistics().total_physical_size
  for (let round = 0; round < MAX_FILL_ROUNDS && held <= target; round++) {
    kept = []
    for (let i = 0; i < 200_000; i++) kept.push({ id: `d${i}`, words: [`term${i}`, `term${i + 1}`] })
    held = getHeapStatistics().total_physical_size
  }
  if (kept.length === 0) throw new Error('unreachable')
  return held
}

describe('idle heap cleanup on a real thread', () => {
  it('returns the heap pages of a thread that went quiet', async () => {
    const heldWhileBusy = growHeapPast(GROWN_HEAP_BYTES)
    expect(heldWhileBusy).toBeGreaterThan(GROWN_HEAP_BYTES)

    const stop = startIdleHeapCleanup()
    try {
      const quietMs = IDLE_HEAP_CLEANUP_CHECK_MS * (IDLE_HEAP_CLEANUP_QUIET_CHECKS + 2)
      await new Promise(resolve => setTimeout(resolve, quietMs))
    } finally {
      stop()
    }

    expect(getHeapStatistics().total_physical_size).toBeLessThan(heldWhileBusy / 2)
  }, 30_000)
})
