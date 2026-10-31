import { TYPO_CLAIM_SLOTS_PER_WORD } from '../core/pattern-index/constants'
import type { PatternMatchRequest, PatternTolerance, PatternWorkMeter } from '../core/pattern-index/types'
import type { FilterExpression } from '../types/filters'

const slotsBySearch = new WeakMap<PatternWorkMeter, ReadonlyMap<string, number>>()

function typoTestKey(caseFold: boolean, tolerance: PatternTolerance, text: string): string {
  return `${caseFold}|${tolerance}|${text}`
}

function collectSlots(expression: FilterExpression, slots: Map<string, number>): void {
  for (const filter of Object.values(expression.fields ?? {})) {
    const { eq, tolerance, caseFold } = filter as { eq?: unknown; tolerance?: PatternTolerance; caseFold?: unknown }
    if (typeof eq !== 'string' || tolerance === undefined) continue
    const key = typoTestKey(caseFold === true, tolerance, eq)
    if (!slots.has(key)) slots.set(key, slots.size)
  }
  for (const child of expression.and ?? []) collectSlots(child, slots)
  for (const child of expression.or ?? []) collectSlots(child, slots)
  if (expression.not !== undefined) collectSlots(expression.not, slots)
}

function slotsOf(meter: PatternWorkMeter): ReadonlyMap<string, number> {
  let slots = slotsBySearch.get(meter)
  if (slots === undefined) {
    const collected = new Map<string, number>()
    if (meter.filters !== undefined) collectSlots(meter.filters, collected)
    slots = collected
    slotsBySearch.set(meter, slots)
  }
  return slots
}

export function claimsTypoPreparation(request: PatternMatchRequest): boolean {
  const { meter, caseFold, tolerance, text } = request
  if (meter.preparedTypoTests === null) return true
  const claimed = new Int32Array(meter.preparedTypoTests)
  const slot = slotsOf(meter).get(typoTestKey(caseFold, tolerance, text))
  if (slot === undefined || slot >= claimed.length * TYPO_CLAIM_SLOTS_PER_WORD) return true
  const bit = 1 << (slot % TYPO_CLAIM_SLOTS_PER_WORD)
  return (Atomics.or(claimed, Math.floor(slot / TYPO_CLAIM_SLOTS_PER_WORD), bit) & bit) === 0
}
