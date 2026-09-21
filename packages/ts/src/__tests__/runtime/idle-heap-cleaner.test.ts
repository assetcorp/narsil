import { describe, expect, it } from 'vitest'
import { IDLE_HEAP_CLEANUP_MIN_RECLAIMABLE_BYTES } from '../../runtime/constants'
import { createIdleHeapCleaner, type ThreadHeap } from '../../runtime/idle-heap-cleaner'

const MB = 1024 * 1024

interface FakeThread {
  utilisation: number
  heap: ThreadHeap | null
  liveAfterCollection: number
  collections: number
  collectorAvailable: boolean
}

function cleanerOver(thread: FakeThread) {
  return createIdleHeapCleaner({
    utilisationSinceLastCheck: () => thread.utilisation,
    readHeap: () => thread.heap,
    collectAndReturnPages: () => {
      if (!thread.collectorAvailable) return false
      thread.collections += 1
      thread.heap = { heldBytes: thread.liveAfterCollection + 4 * MB, liveBytes: thread.liveAfterCollection }
      return true
    },
  })
}

function quietThreadHolding(heldBytes: number): FakeThread {
  return {
    utilisation: 0.01,
    heap: { heldBytes, liveBytes: heldBytes / 2 },
    liveAfterCollection: 70 * MB,
    collections: 0,
    collectorAvailable: true,
  }
}

describe('the idle heap cleaner of one thread', () => {
  it('collects once after the thread stays quiet for two checks', () => {
    const thread = quietThreadHolding(300 * MB)
    const cleaner = cleanerOver(thread)

    expect(cleaner.check()).toBe(false)
    expect(cleaner.check()).toBe(true)
    expect(thread.collections).toBe(1)
  })

  it('never collects while the thread is busy, and starts the quiet count again afterwards', () => {
    const thread = quietThreadHolding(300 * MB)
    const cleaner = cleanerOver(thread)

    cleaner.check()
    thread.utilisation = 0.9
    expect(cleaner.check()).toBe(false)
    thread.utilisation = 0.01
    expect(cleaner.check()).toBe(false)
    expect(thread.collections).toBe(0)
    expect(cleaner.check()).toBe(true)
  })

  it('holds back while the heap still grows, however quiet the thread has been', () => {
    const thread = quietThreadHolding(10 * MB)
    const cleaner = cleanerOver(thread)
    for (let round = 0; round < 10; round++) cleaner.check()

    thread.heap = { heldBytes: 200 * MB, liveBytes: 150 * MB }
    expect(cleaner.check()).toBe(false)
    thread.heap = { heldBytes: 400 * MB, liveBytes: 300 * MB }
    expect(cleaner.check()).toBe(false)
    expect(cleaner.check()).toBe(false)
    expect(thread.collections).toBe(0)
    expect(cleaner.check()).toBe(true)
  })

  it('leaves a small heap alone', () => {
    const thread = quietThreadHolding(IDLE_HEAP_CLEANUP_MIN_RECLAIMABLE_BYTES - 1)
    const cleaner = cleanerOver(thread)

    for (let round = 0; round < 5; round++) expect(cleaner.check()).toBe(false)
    expect(thread.collections).toBe(0)
  })

  it('stays away from a quiet thread until its heap grows again past what the last collection left live', () => {
    const thread = quietThreadHolding(300 * MB)
    const cleaner = cleanerOver(thread)
    cleaner.check()
    cleaner.check()

    for (let round = 0; round < 5; round++) expect(cleaner.check()).toBe(false)
    expect(thread.collections).toBe(1)

    thread.heap = { heldBytes: 70 * MB + IDLE_HEAP_CLEANUP_MIN_RECLAIMABLE_BYTES, liveBytes: 100 * MB }
    expect(cleaner.check()).toBe(false)
    expect(cleaner.check()).toBe(false)
    expect(cleaner.check()).toBe(true)
    expect(thread.collections).toBe(2)
  })

  it('tries again at a later check when the runtime offers no collector yet', () => {
    const thread = quietThreadHolding(300 * MB)
    thread.collectorAvailable = false
    const cleaner = cleanerOver(thread)

    cleaner.check()
    expect(cleaner.check()).toBe(false)
    thread.collectorAvailable = true
    expect(cleaner.check()).toBe(true)
  })
})
