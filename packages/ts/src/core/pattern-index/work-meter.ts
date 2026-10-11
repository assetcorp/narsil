import { ErrorCodes, NarsilError } from '../../errors'
import { DEFAULT_PATTERN_WORK_CAP, MATCHER_STATE_BUDGET_BYTES, PATTERN_WORK_FLUSH_UNITS } from './constants'
import type { PatternWorkMeter } from './types'

export interface SharedPatternWork {
  readonly cap: number
  readonly spent: number
  readonly counter: SharedArrayBuffer | null
  readonly matcherStateBytes: number
  readonly flushUnits: number
}

export interface PatternWorkFork {
  readonly shared: SharedPatternWork
  settle(reportedUnits: number): void
}

export interface SearchPatternWork extends PatternWorkMeter {
  readonly cap: number
  fork(workerCount: number): PatternWorkFork
}

export interface JoinedPatternWork extends PatternWorkMeter {
  spent(): number
}

const COUNTER_BYTES = 8

function capExceeded(cap: number): NarsilError {
  return new NarsilError(
    ErrorCodes.SEARCH_WORK_CAP_EXCEEDED,
    `The engine stopped this search before it checked every candidate, because the work on its pattern tests passed the cap of ${cap} units. Narrow the tests, or raise the patternWorkCap engine setting`,
    { cap },
  )
}

function localMeter(cap: number, spent: number, matcherStateBytes: number, flushUnits: number): SearchPatternWork {
  let total = spent
  let sharedCount: BigInt64Array | null = null
  const spentSoFar = (): number => (sharedCount === null ? total : Number(Atomics.load(sharedCount, 0)))
  const meter: SearchPatternWork = {
    cap,
    matcherStateBytes,
    flushUnits,
    add(units: number): void {
      if (units <= 0) return
      if (sharedCount === null) total += units
      else total = Number(Atomics.add(sharedCount, 0, BigInt(units))) + units
      if (total > cap) throw capExceeded(cap)
    },
    remaining(): number {
      return cap - spentSoFar()
    },
    fork(workerCount: number): PatternWorkFork {
      const copies = Math.max(1, workerCount)
      const seed = spentSoFar()
      let counter: SharedArrayBuffer | null = null
      if (typeof SharedArrayBuffer === 'function') {
        counter = new SharedArrayBuffer(COUNTER_BYTES)
        new BigInt64Array(counter)[0] = BigInt(seed)
      }
      const shared: SharedPatternWork = {
        cap,
        spent: seed,
        counter,
        matcherStateBytes: Math.floor(matcherStateBytes / copies),
        flushUnits: Math.max(1, Math.floor(flushUnits / copies)),
      }
      return {
        shared,
        settle(reportedUnits: number): void {
          if (counter === null) {
            meter.add(reportedUnits)
            return
          }
          const unitsSinceFork = spentSoFar() - seed
          const view = new BigInt64Array(counter)
          if (unitsSinceFork > 0) Atomics.add(view, 0, BigInt(unitsSinceFork))
          sharedCount = view
          total = spentSoFar()
          if (total > cap) throw capExceeded(cap)
        },
      }
    },
  }
  return meter
}

export function createPatternWorkMeter(cap: number = DEFAULT_PATTERN_WORK_CAP): SearchPatternWork {
  return localMeter(cap, 0, MATCHER_STATE_BUDGET_BYTES, PATTERN_WORK_FLUSH_UNITS)
}

function sharedMeter(work: SharedPatternWork, counter: SharedArrayBuffer): PatternWorkMeter {
  const view = new BigInt64Array(counter)
  return {
    matcherStateBytes: work.matcherStateBytes,
    flushUnits: work.flushUnits,
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

export function joinPatternWorkMeter(work: SharedPatternWork): JoinedPatternWork {
  const meter =
    work.counter === null
      ? localMeter(work.cap, work.spent, work.matcherStateBytes, work.flushUnits)
      : sharedMeter(work, work.counter)
  let spent = 0
  return {
    matcherStateBytes: meter.matcherStateBytes,
    flushUnits: meter.flushUnits,
    add(units: number): void {
      if (units <= 0) return
      spent += units
      meter.add(units)
    },
    remaining: () => meter.remaining(),
    spent: () => spent,
  }
}
