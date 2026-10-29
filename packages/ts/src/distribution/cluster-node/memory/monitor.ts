import type { NodeMemoryReport } from '../../coordinator/types'
import type { MemoryFractions } from './fractions'
import type { MemoryFigures } from './measure'

export interface MemoryMonitorOptions {
  fractions: MemoryFractions
  intervalMs: number
  collectionIntervalMs: number
  read: () => MemoryFigures | null
  collectGarbage: () => boolean
  collectGarbageBeforeRefusal: () => boolean
  collectYoungGenerationBeforeRefusal: () => boolean
  onFullChange: (full: boolean) => void
}

export interface MemoryMonitor {
  report(): NodeMemoryReport | null
  isFull(): boolean
  sample(): void
  sampleIfOlderThan(maxAgeMs: number): void
  measureWithoutGarbage(): MemoryFigures | null
  refusedAfterCollection(figures: MemoryFigures): void
  collections(): number
  start(): void
  stop(): void
}

function fractionOf(usedBytes: number, limitBytes: number): number {
  return limitBytes > 0 ? usedBytes / limitBytes : 0
}

function reportOf(figures: MemoryFigures, full: boolean): NodeMemoryReport {
  return {
    processBytes: figures.processBytes,
    processLimitBytes: figures.processLimitBytes,
    heapBytes: figures.heapBytes,
    heapLimitBytes: figures.heapLimitBytes,
    full,
  }
}

function atOrAboveResume(figures: MemoryFigures, fractions: MemoryFractions): boolean {
  return (
    fractionOf(figures.processBytes, figures.processLimitBytes) >= fractions.processResume ||
    fractionOf(figures.heapBytes, figures.heapLimitBytes) >= fractions.heapResume
  )
}

function nextFullState(wasFull: boolean, figures: MemoryFigures, fractions: MemoryFractions): boolean {
  if (wasFull) return atOrAboveResume(figures, fractions)
  return (
    fractionOf(figures.processBytes, figures.processLimitBytes) > fractions.processBlock ||
    fractionOf(figures.heapBytes, figures.heapLimitBytes) > fractions.heapBlock
  )
}

export function createMemoryMonitor(options: MemoryMonitorOptions): MemoryMonitor {
  let latest: NodeMemoryReport | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let lastCollectionAt = Number.NEGATIVE_INFINITY
  let lastSampleAt = Number.NEGATIVE_INFINITY
  let collectionCount = 0
  let latestMeasured: MemoryFigures | null = null

  function figuresWithoutGarbageBeforeRefusal(figures: MemoryFigures): MemoryFigures {
    if (!options.collectGarbageBeforeRefusal()) {
      return options.collectYoungGenerationBeforeRefusal() ? (options.read() ?? figures) : figures
    }
    collectionCount++
    return options.read() ?? figures
  }

  function figuresWithoutGarbage(figures: MemoryFigures): MemoryFigures {
    const now = Date.now()
    if (now - lastCollectionAt < options.collectionIntervalMs) {
      return figures
    }
    lastCollectionAt = now
    if (!options.collectGarbage()) {
      return figures
    }
    collectionCount++
    return options.read() ?? figures
  }

  function record(figures: MemoryFigures): void {
    const wasFull = latest?.full ?? false
    let full = nextFullState(wasFull, figures, options.fractions)
    let settled = figures
    if (full) {
      settled = figuresWithoutGarbage(figures)
      full = nextFullState(wasFull, settled, options.fractions)
    }
    latestMeasured = settled
    latest = reportOf(settled, full)
    if (full !== wasFull) {
      options.onFullChange(full)
    }
  }

  function sample(): void {
    lastSampleAt = Date.now()
    const figures = options.read()
    if (figures !== null) {
      record(figures)
    }
  }

  function latestFigures(): MemoryFigures | null {
    return latestMeasured
  }

  return {
    report: () => latest,
    isFull: () => latest?.full ?? false,
    sample,
    measureWithoutGarbage() {
      lastSampleAt = Date.now()
      const figures = options.read()
      if (figures === null) return latestFigures()
      record(figuresWithoutGarbageBeforeRefusal(figures))
      return latestFigures()
    },
    refusedAfterCollection(figures) {
      if (latest?.full === true) return
      if (!atOrAboveResume(figures, options.fractions)) return
      latestMeasured = { ...figures }
      latest = reportOf(figures, true)
      options.onFullChange(true)
    },
    collections: () => collectionCount,
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
