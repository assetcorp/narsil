import type { NodeMemoryReport } from '../../coordinator/types'
import type { MemoryFigures } from './measure'

export interface MemoryMonitorOptions {
  blockWritesAbove: number
  resumeWritesBelow: number
  intervalMs: number
  collectionIntervalMs: number
  read: () => MemoryFigures | null
  collectGarbage: () => boolean
  onFullChange: (full: boolean) => void
}

export interface MemoryMonitor {
  report(): NodeMemoryReport | null
  isFull(): boolean
  sample(): void
  sampleIfOlderThan(maxAgeMs: number): void
  start(): void
  stop(): void
}

function fractionOf(usedBytes: number, limitBytes: number): number {
  return limitBytes > 0 ? usedBytes / limitBytes : 0
}

function nextFullState(wasFull: boolean, figures: MemoryFigures, options: MemoryMonitorOptions): boolean {
  const processFraction = fractionOf(figures.processBytes, figures.processLimitBytes)
  const heapFraction = fractionOf(figures.heapBytes, figures.heapLimitBytes)
  if (!wasFull) {
    return processFraction > options.blockWritesAbove || heapFraction > options.blockWritesAbove
  }
  return processFraction >= options.resumeWritesBelow || heapFraction >= options.resumeWritesBelow
}

export function createMemoryMonitor(options: MemoryMonitorOptions): MemoryMonitor {
  let latest: NodeMemoryReport | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let lastCollectionAt = Number.NEGATIVE_INFINITY
  let lastSampleAt = Number.NEGATIVE_INFINITY

  function figuresWithoutGarbage(figures: MemoryFigures): MemoryFigures {
    const now = Date.now()
    if (now - lastCollectionAt < options.collectionIntervalMs) {
      return figures
    }
    lastCollectionAt = now
    if (!options.collectGarbage()) {
      return figures
    }
    return options.read() ?? figures
  }

  function sample(): void {
    lastSampleAt = Date.now()
    let figures = options.read()
    if (figures === null) {
      return
    }
    const wasFull = latest?.full ?? false
    let full = nextFullState(wasFull, figures, options)
    if (full) {
      figures = figuresWithoutGarbage(figures)
      full = nextFullState(wasFull, figures, options)
    }
    latest = { ...figures, full }
    if (full !== wasFull) {
      options.onFullChange(full)
    }
  }

  return {
    report: () => latest,
    isFull: () => latest?.full ?? false,
    sample,
    sampleIfOlderThan(maxAgeMs) {
      if (timer !== null && Date.now() - lastSampleAt >= maxAgeMs) {
        sample()
      }
    },
    start() {
      if (timer !== null) {
        return
      }
      sample()
      timer = setInterval(sample, options.intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
