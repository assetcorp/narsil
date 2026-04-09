import type { FacetBucket, ScoredEntry } from '../transport/types'

function compareScoredEntries(a: ScoredEntry, b: ScoredEntry): number {
  if (a.score !== b.score) {
    return b.score - a.score
  }
  if (a.docId < b.docId) return -1
  if (a.docId > b.docId) return 1
  return 0
}

export function mergeAndTruncateScoredEntries(arrays: ScoredEntry[][], limit: number): ScoredEntry[] {
  const nonEmpty = arrays.filter(a => a.length > 0)

  if (nonEmpty.length === 0) return []
  if (nonEmpty.length === 1) return nonEmpty[0].slice(0, limit)

  if (nonEmpty.length <= 4) {
    return sequentialMergeScoredEntries(nonEmpty, limit)
  }

  return heapMergeScoredEntries(nonEmpty, limit)
}

function sequentialMergeScoredEntries(arrays: ScoredEntry[][], limit: number): ScoredEntry[] {
  let merged = arrays[0]

  for (let i = 1; i < arrays.length; i++) {
    merged = mergeTwoSortedScoredEntries(merged, arrays[i])
  }

  return merged.slice(0, limit)
}

function mergeTwoSortedScoredEntries(a: ScoredEntry[], b: ScoredEntry[]): ScoredEntry[] {
  const result: ScoredEntry[] = new Array(a.length + b.length)
  let ai = 0
  let bi = 0
  let ri = 0

  while (ai < a.length && bi < b.length) {
    if (compareScoredEntries(a[ai], b[bi]) <= 0) {
      result[ri++] = a[ai++]
    } else {
      result[ri++] = b[bi++]
    }
  }

  while (ai < a.length) {
    result[ri++] = a[ai++]
  }

  while (bi < b.length) {
    result[ri++] = b[bi++]
  }

  return result
}

interface ScoredHeapNode {
  score: number
  docId: string
  sourceIdx: number
  resultIdx: number
}

function scoredHeapNodeGreater(a: ScoredHeapNode, b: ScoredHeapNode): boolean {
  if (a.score !== b.score) return a.score > b.score
  return a.docId < b.docId
}

function heapMergeScoredEntries(arrays: ScoredEntry[][], limit: number): ScoredEntry[] {
  const heap: ScoredHeapNode[] = []

  for (let i = 0; i < arrays.length; i++) {
    if (arrays[i].length > 0) {
      pushScoredHeap(heap, {
        score: arrays[i][0].score,
        docId: arrays[i][0].docId,
        sourceIdx: i,
        resultIdx: 0,
      })
    }
  }

  const result: ScoredEntry[] = []

  while (heap.length > 0 && result.length < limit) {
    const top = popScoredHeap(heap)
    result.push(arrays[top.sourceIdx][top.resultIdx])

    const nextIdx = top.resultIdx + 1
    if (nextIdx < arrays[top.sourceIdx].length) {
      const nextEntry = arrays[top.sourceIdx][nextIdx]
      pushScoredHeap(heap, {
        score: nextEntry.score,
        docId: nextEntry.docId,
        sourceIdx: top.sourceIdx,
        resultIdx: nextIdx,
      })
    }
  }

  return result
}

function pushScoredHeap(heap: ScoredHeapNode[], node: ScoredHeapNode): void {
  heap.push(node)
  let idx = heap.length - 1

  while (idx > 0) {
    const parentIdx = (idx - 1) >> 1
    if (scoredHeapNodeGreater(heap[idx], heap[parentIdx])) {
      const tmp = heap[idx]
      heap[idx] = heap[parentIdx]
      heap[parentIdx] = tmp
      idx = parentIdx
    } else {
      break
    }
  }
}

function popScoredHeap(heap: ScoredHeapNode[]): ScoredHeapNode {
  const top = heap[0]
  const last = heap.pop()

  if (heap.length > 0 && last !== undefined) {
    heap[0] = last
    let idx = 0

    for (;;) {
      const left = 2 * idx + 1
      const right = 2 * idx + 2
      let largest = idx

      if (left < heap.length && scoredHeapNodeGreater(heap[left], heap[largest])) {
        largest = left
      }
      if (right < heap.length && scoredHeapNodeGreater(heap[right], heap[largest])) {
        largest = right
      }

      if (largest !== idx) {
        const tmp = heap[idx]
        heap[idx] = heap[largest]
        heap[largest] = tmp
        idx = largest
      } else {
        break
      }
    }
  }

  return top
}

const DEFAULT_MAX_FACET_BUCKETS = 100

export function mergeDistributedFacets(
  allFacets: Array<Record<string, FacetBucket[]>>,
  maxBuckets: number = DEFAULT_MAX_FACET_BUCKETS,
): Record<string, FacetBucket[]> {
  const merged = new Map<string, Map<string, number>>()

  for (const facetMap of allFacets) {
    for (const [field, buckets] of Object.entries(facetMap)) {
      let fieldMap = merged.get(field)
      if (fieldMap === undefined) {
        fieldMap = new Map<string, number>()
        merged.set(field, fieldMap)
      }

      for (const bucket of buckets) {
        fieldMap.set(bucket.value, (fieldMap.get(bucket.value) ?? 0) + bucket.count)
      }
    }
  }

  const result: Record<string, FacetBucket[]> = {}

  for (const [field, valueMap] of merged) {
    const buckets: FacetBucket[] = []
    for (const [value, count] of valueMap) {
      buckets.push({ value, count })
    }

    buckets.sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count
      if (a.value < b.value) return -1
      if (a.value > b.value) return 1
      return 0
    })

    result[field] = buckets.slice(0, maxBuckets)
  }

  return result
}
