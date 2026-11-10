export interface MinHeap {
  numbers: number[]
  distances: number[]
}

export function pushMin(heap: MinHeap, number: number, distance: number): void {
  let at = heap.numbers.length
  heap.numbers.push(number)
  heap.distances.push(distance)
  while (at > 0) {
    const parent = (at - 1) >> 1
    if (heap.distances[parent] <= distance) break
    heap.numbers[at] = heap.numbers[parent]
    heap.distances[at] = heap.distances[parent]
    at = parent
  }
  heap.numbers[at] = number
  heap.distances[at] = distance
}

export function popMin(heap: MinHeap): { number: number; distance: number } | null {
  const size = heap.numbers.length
  if (size === 0) return null
  const top = { number: heap.numbers[0], distance: heap.distances[0] }
  const number = heap.numbers[size - 1]
  const distance = heap.distances[size - 1]
  heap.numbers.pop()
  heap.distances.pop()
  const remaining = size - 1
  if (remaining === 0) return top
  let at = 0
  for (;;) {
    let child = 2 * at + 1
    if (child >= remaining) break
    if (child + 1 < remaining && heap.distances[child + 1] < heap.distances[child]) child += 1
    if (heap.distances[child] >= distance) break
    heap.numbers[at] = heap.numbers[child]
    heap.distances[at] = heap.distances[child]
    at = child
  }
  heap.numbers[at] = number
  heap.distances[at] = distance
  return top
}

export function negated(heap: MinHeap): number {
  return heap.distances.length === 0 ? Number.POSITIVE_INFINITY : -heap.distances[0]
}
