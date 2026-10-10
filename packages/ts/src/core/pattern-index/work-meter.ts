import { ErrorCodes, NarsilError } from '../../errors'
import { DEFAULT_PATTERN_WORK_CAP, MAX_MATCHER_STATE_BYTES } from './constants'
import type { PatternWorkMeter } from './types'

export interface SharedPatternWork {
  readonly cap: number
  readonly spent: number
  readonly counter: SharedArrayBuffer | null
  readonly matcherStateBytes: number
}

export interface PatternWorkFork {
  readonly shared: SharedPatternWork
  absorb(): void
}

export interface SearchPatternWork extends PatternWorkMeter {
  readonly cap: number
  fork(workerCount: number): PatternWorkFork
}

const COUNTER_BYTES = 8

function capExceeded(cap: number): NarsilError {
  return new NarsilError(
    ErrorCodes.SEARCH_WORK_CAP_EXCEEDED,
    `The pattern tests of this search passed the work cap of ${cap} units, so the engine stopped before it checked every candidate. Narrow the tests, or raise the patternWorkCap engine setting`,
    { cap },
  )
}

function localMeter(cap: number, spent: number, matcherStateBytes: number): SearchPatternWork {
  let total = spent
  const meter: SearchPatternWork = {
    cap,
    matcherStateBytes,
    add(units: number): void {
      if (units <= 0) return
      total += units
      if (total > cap) throw capExceeded(cap)
    },
    remaining(): number {
      return cap - total
    },
    fork(workerCount: number): PatternWorkFork {
      const shareOfState = Math.floor(matcherStateBytes / Math.max(1, workerCount))
      if (typeof SharedArrayBuffer !== 'function') {
        return { shared: { cap, spent: total, counter: null, matcherStateBytes: shareOfState }, absorb: () => {} }
      }
      const counter = new SharedArrayBuffer(COUNTER_BYTES)
      const view = new BigInt64Array(counter)
      const seed = total
      view[0] = BigInt(seed)
      return {
        shared: { cap, spent: seed, counter, matcherStateBytes: shareOfState },
        absorb: () => meter.add(Number(Atomics.load(view, 0)) - seed),
      }
    },
  }
  return meter
}

export function createPatternWorkMeter(cap: number = DEFAULT_PATTERN_WORK_CAP): SearchPatternWork {
  return localMeter(cap, 0, MAX_MATCHER_STATE_BYTES)
}

export function joinPatternWorkMeter(work: SharedPatternWork | undefined): PatternWorkMeter {
  if (work === undefined) return createPatternWorkMeter()
  if (work.counter === null) return localMeter(work.cap, work.spent, work.matcherStateBytes)
  const view = new BigInt64Array(work.counter)
  return {
    matcherStateBytes: work.matcherStateBytes,
    add(units: number): void {
      if (units <= 0) return
      const total = Number(Atomics.add(view, 0, BigInt(units))) + units
      if (total > work.cap) throw capExceeded(work.cap)
    },
    remaining(): number {
      return work.cap - Number(Atomics.load(view, 0))
    },
  }
}
