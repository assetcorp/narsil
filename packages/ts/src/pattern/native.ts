import { loadNativeCore } from '#platform/native-core'
import type { PatternMatchRequest, PatternOperator, PatternWorkMeter } from '../core/pattern-index/types'
import { ErrorCodes, NarsilError } from '../errors'
import { nativeSearchCoreIsEnabled, noteFallback } from '../vector/native/backend'
import { matchPattern as portable } from './evaluate'
import { claimsTypoPreparation } from './typo-claims'

const operators: Readonly<Record<PatternOperator, number>> = {
  eq: 0,
  startsWith: 1,
  endsWith: 2,
  contains: 3,
  wildcard: 4,
  regex: 5,
}
const STOPPED = -7
const NANOSECONDS_PER_MILLISECOND = 1_000_000
const LAST_CLOCK_VALUE = 0xffffffffffffffffn

interface SearchBuffers {
  texts: Map<string, Uint16Array>
  options: Uint32Array
  deadline: BigUint64Array
}

const buffers = new WeakMap<PatternWorkMeter, SearchBuffers>()

function buffersOf(meter: PatternWorkMeter): SearchBuffers {
  let held = buffers.get(meter)
  if (held === undefined) {
    held = {
      texts: new Map(),
      options: new Uint32Array(5),
      deadline: new BigUint64Array(1),
    }
    buffers.set(meter, held)
  }
  return held
}

function unitsOf(held: SearchBuffers, text: string): Uint16Array {
  let units = held.texts.get(text)
  if (units === undefined) {
    units = new Uint16Array(text.length)
    for (let at = 0; at < text.length; at++) units[at] = text.charCodeAt(at)
    held.texts.set(text, units)
  }
  return units
}

export function matchPattern(request: PatternMatchRequest): void {
  const core = nativeSearchCoreIsEnabled() ? loadNativeCore() : null
  if (core === null) {
    if (nativeSearchCoreIsEnabled()) noteFallback('patternTest')
    portable(request)
    return
  }
  const { meter, index, values, text, operator, tolerance, caseFold, matches } = request
  meter.clock?.check()
  const held = buffersOf(meter)
  const units = unitsOf(held, text)
  const arrays = index.regions()
  held.options[0] = operators[operator]
  held.options[1] = Number(caseFold)
  held.options[2] = tolerance === 'auto' ? 3 : tolerance
  held.options[3] = Number(operator === 'eq' && tolerance !== 0 && claimsTypoPreparation(request))
  held.options[4] = meter.matcherStateBytes
  const window = meter.clock?.nativeWindow?.()
  held.deadline[0] = 0n
  if (window !== undefined) {
    const status = core.clockNow(held.deadline)
    if (status !== 0) throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The search clock could not be read', { status })
    if (held.deadline[0] === LAST_CLOCK_VALUE) window.expired()
    const deadline = held.deadline[0] + BigInt(Math.ceil(window.milliseconds * NANOSECONDS_PER_MILLISECOND))
    held.deadline[0] = deadline > LAST_CLOCK_VALUE ? LAST_CLOCK_VALUE : deadline
  }
  const status = meter.nativeWork(counter =>
    core.patternTest(
      arrays.docIds,
      arrays.runs,
      arrays.offsets,
      arrays.postings,
      values,
      units,
      held.options,
      counter,
      meter.stopFlag(),
      held.deadline,
      matches,
    ),
  )
  if (status === STOPPED && window !== undefined) window.expired()
  if (status !== 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The stored pattern test could not be evaluated', {
      status: -status,
    })
  }
}
