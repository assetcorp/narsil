export interface RemovedSpellings {
  readonly spellings: readonly string[]
  readonly counts: readonly number[]
}

export const NO_REMOVED_SPELLINGS: RemovedSpellings = { spellings: [], counts: [] }

const heldSpellings: string[] = []
const heldEntries = new Map<string, number>()
const heldCounts: number[] = []
let indexedSpellings = 0

export function beginRemovedSpellings(): void {
  heldSpellings.length = 0
  heldCounts.length = 0
  heldEntries.clear()
  indexedSpellings = 0
}

function appendSpelling(spelling: string, count: number): void {
  heldCounts.push(count)
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
  return { spellings: heldSpellings.slice(), counts: heldCounts.slice() }
}
