import { compareCodePoints } from '../ordering'

/**
 * One document competing for a place on the page, held in the selection heap.
 *
 * @internal
 */
export interface TopKCandidate {
  internalId: number
  externalId: string
  score: number
}

/**
 * Reports whether the first candidate ranks below the second, scoring first and
 * breaking a tie on the document id.
 *
 * @param a - The candidate to test.
 * @param b - The candidate to compare against.
 * @returns True where `a` ranks below `b`.
 */
export function candidateWorse(a: TopKCandidate, b: TopKCandidate): boolean {
  if (a.score !== b.score) return a.score < b.score
  return compareCodePoints(a.externalId, b.externalId) > 0
}

/**
 * Arranges a full selection into a heap whose root is its lowest-ranking entry.
 *
 * @param heap - The candidates gathered so far.
 */
export function buildMinHeap(heap: TopKCandidate[]): void {
  for (let index = (heap.length >> 1) - 1; index >= 0; index--) {
    siftDown(heap, index)
  }
}

/**
 * Restores the heap after the entry at the given position was replaced.
 *
 * @param heap - The selection heap.
 * @param start - The position to sift from.
 */
export function siftDown(heap: TopKCandidate[], start: number): void {
  const len = heap.length
  let current = start
  for (;;) {
    let worst = current
    const left = 2 * current + 1
    const right = 2 * current + 2
    if (left < len && candidateWorse(heap[left], heap[worst])) worst = left
    if (right < len && candidateWorse(heap[right], heap[worst])) worst = right
    if (worst === current) break
    const held = heap[current]
    heap[current] = heap[worst]
    heap[worst] = held
    current = worst
  }
}

/**
 * Puts the selection into descending page order, highest score first and ties
 * broken on the document id.
 *
 * @param heap - The selection heap.
 */
export function sortSelection(heap: TopKCandidate[]): void {
  heap.sort((a, b) => b.score - a.score || compareCodePoints(a.externalId, b.externalId))
}
