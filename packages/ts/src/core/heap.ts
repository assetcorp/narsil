export interface BinaryHeap<T> {
  push(item: T): void
  pop(): T | undefined
  peek(): T | undefined
  readonly size: number
  toSortedArray(): T[]
}

export function createMinHeap<T>(compare: (a: T, b: T) => number): BinaryHeap<T> {
  return createHeap(compare)
}

export function createMaxHeap<T>(compare: (a: T, b: T) => number): BinaryHeap<T> {
  return createHeap((a, b) => compare(b, a))
}

export function createBoundedMaxHeap<T>(compare: (a: T, b: T) => number, capacity: number): BinaryHeap<T> {
  const heap = createMaxHeap(compare)
  const innerPush = heap.push

  return {
    push(item: T): void {
      if (heap.size < capacity) {
        innerPush(item)
        return
      }
      const top = heap.peek()
      if (top !== undefined && compare(item, top) < 0) {
        heap.pop()
        innerPush(item)
      }
    },
    pop: heap.pop,
    peek: heap.peek,
    get size() {
      return heap.size
    },
    toSortedArray: heap.toSortedArray,
  }
}

function createHeap<T>(compare: (a: T, b: T) => number): BinaryHeap<T> {
  const items: T[] = []

  function siftUp(idx: number): void {
    while (idx > 0) {
      const parent = (idx - 1) >> 1
      if (compare(items[idx], items[parent]) >= 0) break
      const tmp = items[idx]
      items[idx] = items[parent]
      items[parent] = tmp
      idx = parent
    }
  }

  function siftDown(idx: number): void {
    const len = items.length
    while (true) {
      let smallest = idx
      const left = 2 * idx + 1
      const right = 2 * idx + 2
      if (left < len && compare(items[left], items[smallest]) < 0) smallest = left
      if (right < len && compare(items[right], items[smallest]) < 0) smallest = right
      if (smallest === idx) break
      const tmp = items[idx]
      items[idx] = items[smallest]
      items[smallest] = tmp
      idx = smallest
    }
  }

  return {
    push(item: T): void {
      items.push(item)
      siftUp(items.length - 1)
    },

    pop(): T | undefined {
      if (items.length === 0) return undefined
      const top = items[0]
      const last = items.pop() as T
      if (items.length > 0) {
        items[0] = last
        siftDown(0)
      }
      return top
    },

    peek(): T | undefined {
      return items[0]
    },

    get size() {
      return items.length
    },

    toSortedArray(): T[] {
      return [...items].sort(compare)
    },
  }
}
