import { REMOVED_SPELLINGS_START_ENTRIES, REMOVED_STRING_GROWTH_FACTOR } from './constants'

export interface RemovedSpellings {
  readonly spellings: readonly string[]
  readonly counts: Uint32Array
}

export const NO_REMOVED_SPELLINGS: RemovedSpellings = { spellings: [], counts: new Uint32Array(0) }

const heldSpellings: string[] = []
const heldEntries = new Map<string, number>()
let heldCounts = new Uint32Array(REMOVED_SPELLINGS_START_ENTRIES)
let indexedSpellings = 0

export function beginRemovedSpellings(): void {
  heldSpellings.length = 0
  heldEntries.clear()
  indexedSpellings = 0
}

function appendSpelling(spelling: string, count: number): void {
  const next = heldSpellings.length
  if (next === heldCounts.length) {
    const grown = new Uint32Array(heldCounts.length * REMOVED_STRING_GROWTH_FACTOR)
    grown.set(heldCounts)
    heldCounts = grown
  }
  heldCounts[next] = count
  heldSpellings.push(spelling)
}

export function addRemovedSpelling(spelling: string, count: number): void {
  for (; indexedSpellings < heldSpellings.length; indexedSpellings++)
    heldEntries.set(heldSpellings[indexedSpellings], indexedSpellings)
  const entry = heldEntries.get(spelling)
  if (entry !== undefined) {
    heldCounts[entry] += count
    return
  }
  heldEntries.set(spelling, heldSpellings.length)
  appendSpelling(spelling, count)
  indexedSpellings++
}

export function addDistinctRemovedSpellings(words: ReadonlyMap<string, { readonly count: number }>): void {
  if (heldSpellings.length > 0) {
    for (const [spelling, value] of words) addRemovedSpelling(spelling, value.count)
    return
  }
  for (const [spelling, value] of words) appendSpelling(spelling, value.count)
}

export function finishRemovedSpellings(): RemovedSpellings {
  const size = heldSpellings.length
  if (size === 0) return NO_REMOVED_SPELLINGS
  return { spellings: heldSpellings.slice(), counts: heldCounts.slice(0, size) }
}
