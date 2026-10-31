import { ErrorCodes, NarsilError } from '../../errors'
import { MAX_FILTER_TESTS } from '../../filters/constants'
import type { FilterExpression } from '../../types/filters'
import type { SearchClock } from '../search-clock'
import {
  DEFAULT_PATTERN_WORK_CAP,
  MATCHER_STATE_BUDGET_BYTES,
  PATTERN_WORK_FLUSH_UNITS,
  TYPO_CLAIM_SLOTS_PER_WORD,
} from './constants'
import type { PatternWorkMeter } from './types'

export interface SharedPatternWork {
  readonly cap: number
  readonly spent: number
  readonly counter: SharedArrayBuffer | null
  readonly preparedTypoTests: SharedArrayBuffer | null
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
const PREPARED_TYPO_TEST_BYTES = Math.ceil(MAX_FILTER_TESTS / TYPO_CLAIM_SLOTS_PER_WORD) * Int32Array.BYTES_PER_ELEMENT

function capExceeded(cap: number): NarsilError {
  return new NarsilError(
    ErrorCodes.SEARCH_WORK_CAP_EXCEEDED,
    `The engine stopped this search before it checked every candidate, because the work on its pattern tests and phrases passed the cap of ${cap} units. Narrow the tests or the phrases, or raise the patternWorkCap engine setting`,
    { cap },
  )
}

function localMeter(
  cap: number,
  spent: number,
  matcherStateBytes: number,
  flushUnits: number,
  clock: SearchClock | undefined,
): SearchPatternWork {
  let total = spent
  let sharedCount: BigInt64Array | null = null
  const spentSoFar = (): number => (sharedCount === null ? total : Number(Atomics.load(sharedCount, 0)))
  const meter: SearchPatternWork = {
    cap,
    matcherStateBytes,
    flushUnits,
    clock,
    preparedTypoTests: null,
    filters: undefined,
    add(units: number): void {
      if (units <= 0) return
      if (sharedCount === null) total += units
      else total = Number(Atomics.add(sharedCount, 0, BigInt(units))) + units
      if (total > cap) throw capExceeded(cap)
      if (clock !== undefined) clock.tick(units)
    },
    remaining(): number {
      return cap - spentSoFar()
    },
    fork(workerCount: number): PatternWorkFork {
      const copies = Math.max(1, workerCount)
      const seed = spentSoFar()
      let counter: SharedArrayBuffer | null = null
      let preparedTypoTests: SharedArrayBuffer | null = null
      if (typeof SharedArrayBuffer === 'function') {
        counter = new SharedArrayBuffer(COUNTER_BYTES)
        new BigInt64Array(counter)[0] = BigInt(seed)
        preparedTypoTests = new SharedArrayBuffer(PREPARED_TYPO_TEST_BYTES)
      }
      const shared: SharedPatternWork = {
        cap,
        spent: seed,
        counter,
        preparedTypoTests,
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

export function createPatternWorkMeter(cap: number = DEFAULT_PATTERN_WORK_CAP, clock?: SearchClock): SearchPatternWork {
  return localMeter(cap, 0, MATCHER_STATE_BUDGET_BYTES, PATTERN_WORK_FLUSH_UNITS, clock)
}

function sharedMeter(
  work: SharedPatternWork,
  counter: SharedArrayBuffer,
): Omit<PatternWorkMeter, 'preparedTypoTests' | 'filters'> {
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
    clock: undefined,
  }
}

export function joinPatternWorkMeter(work: SharedPatternWork, filters?: FilterExpression): JoinedPatternWork {
  const meter =
    work.counter === null
      ? localMeter(work.cap, work.spent, work.matcherStateBytes, work.flushUnits, undefined)
      : sharedMeter(work, work.counter)
  let spent = 0
  return {
    matcherStateBytes: meter.matcherStateBytes,
    flushUnits: meter.flushUnits,
    preparedTypoTests: work.preparedTypoTests,
    filters,
    add(units: number): void {
      if (units <= 0) return
      spent += units
      meter.add(units)
    },
    remaining: () => meter.remaining(),
    clock: meter.clock,
    spent: () => spent,
  }
}
