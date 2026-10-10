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
  absorb(units: number): void
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
      let counter: SharedArrayBuffer | null = null
      if (typeof SharedArrayBuffer === 'function') {
        counter = new SharedArrayBuffer(COUNTER_BYTES)
        new BigInt64Array(counter)[0] = BigInt(total)
      }
      return {
        shared: { cap, spent: total, counter, matcherStateBytes: shareOfState },
        absorb: units => meter.add(units),
      }
    },
  }
  return meter
}

export function createPatternWorkMeter(cap: number = DEFAULT_PATTERN_WORK_CAP): SearchPatternWork {
  return localMeter(cap, 0, MAX_MATCHER_STATE_BYTES)
}

function sharedMeter(work: SharedPatternWork, counter: SharedArrayBuffer): PatternWorkMeter {
  const view = new BigInt64Array(counter)
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

export function joinPatternWorkMeter(work: SharedPatternWork): JoinedPatternWork {
  const meter =
    work.counter === null ? localMeter(work.cap, work.spent, work.matcherStateBytes) : sharedMeter(work, work.counter)
  let spent = 0
  return {
    matcherStateBytes: meter.matcherStateBytes,
    add(units: number): void {
      if (units <= 0) return
      spent += units
      meter.add(units)
    },
    remaining: () => meter.remaining(),
    spent: () => spent,
  }
}
