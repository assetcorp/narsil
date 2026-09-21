import { type EventLoopUtilization, performance } from 'node:perf_hooks'
import { getHeapStatistics, setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { IDLE_HEAP_CLEANUP_CHECK_MS } from './constants'
import { createIdleHeapCleaner, type ThreadHeap } from './idle-heap-cleaner'

type CollectGarbage = (options: { type: 'major'; execution: 'sync'; flavor: 'last-resort' }) => void

let collectorOfThisThread: CollectGarbage | null = null

function acquireCollector(): CollectGarbage | null {
  if (collectorOfThisThread !== null) return collectorOfThisThread
  try {
    setFlagsFromString('--expose-gc')
    const collect: unknown = runInNewContext('gc')
    setFlagsFromString('--no-expose-gc')
    if (typeof collect !== 'function') return null
    collectorOfThisThread = collect as CollectGarbage
    return collectorOfThisThread
  } catch {
    return null
  }
}

function collectAndReturnPages(): boolean {
  const collect = acquireCollector()
  if (collect === null) return false
  try {
    collect({ type: 'major', execution: 'sync', flavor: 'last-resort' })
    return true
  } catch {
    return false
  }
}

function readHeap(): ThreadHeap | null {
  try {
    const stats = getHeapStatistics()
    return { heldBytes: stats.total_physical_size, liveBytes: stats.used_heap_size }
  } catch {
    return null
  }
}

export function startIdleHeapCleanup(): () => void {
  if (typeof performance.eventLoopUtilization !== 'function') return () => undefined
  let lastReading: EventLoopUtilization = performance.eventLoopUtilization()
  const cleaner = createIdleHeapCleaner({
    utilisationSinceLastCheck(): number {
      const reading = performance.eventLoopUtilization()
      const { utilization } = performance.eventLoopUtilization(reading, lastReading)
      lastReading = reading
      return utilization
    },
    readHeap,
    collectAndReturnPages,
  })
  const timer = setInterval(() => {
    cleaner.check()
  }, IDLE_HEAP_CLEANUP_CHECK_MS)
  timer.unref()
  return () => clearInterval(timer)
}
