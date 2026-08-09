import { compareCodePoints, compareSortValues, type SortDirection } from '../../core/ordering'
import type { FacetBucket, ScoredEntry } from '../transport/types'

type EntryComparator = (a: ScoredEntry, b: ScoredEntry) => number

function compareByScoreThenId(a: ScoredEntry, b: ScoredEntry): number {
  const aScore = a.score ?? Number.NEGATIVE_INFINITY
  const bScore = b.score ?? Number.NEGATIVE_INFINITY
  if (aScore !== bScore) {
    return bScore - aScore
  }
  return compareCodePoints(a.docId, b.docId)
}

export function mergeAndTruncateScoredEntries(arrays: ScoredEntry[][], limit: number): ScoredEntry[] {
  return mergeAndTruncate(arrays, limit, compareByScoreThenId)
}

export function mergeAndTruncateSortedEntries(
  arrays: ScoredEntry[][],
  limit: number,
  directions: readonly SortDirection[],
): ScoredEntry[] {
  const bySortValues: EntryComparator = (a, b) =>
    compareSortValues(a.sortValues ?? [], b.sortValues ?? [], directions) || compareCodePoints(a.docId, b.docId)
  return mergeAndTruncate(arrays, limit, bySortValues)
}

function mergeAndTruncate(arrays: ScoredEntry[][], limit: number, compare: EntryComparator): ScoredEntry[] {
  const nonEmpty = arrays.filter(a => a.length > 0)

  if (nonEmpty.length === 0) return []
  if (nonEmpty.length === 1) return nonEmpty[0].slice(0, limit)

  if (nonEmpty.length <= 4) {
    return sequentialMergeScoredEntries(nonEmpty, limit, compare)
  }

  return heapMergeScoredEntries(nonEmpty, limit, compare)
}

function sequentialMergeScoredEntries(arrays: ScoredEntry[][], limit: number, compare: EntryComparator): ScoredEntry[] {
  let merged = arrays[0]

  for (let i = 1; i < arrays.length; i++) {
    merged = mergeTwoSortedScoredEntries(merged, arrays[i], compare)
  }

  return merged.slice(0, limit)
}

function mergeTwoSortedScoredEntries(a: ScoredEntry[], b: ScoredEntry[], compare: EntryComparator): ScoredEntry[] {
  const result: ScoredEntry[] = new Array(a.length + b.length)
  let ai = 0
  let bi = 0
  let ri = 0

  while (ai < a.length && bi < b.length) {
    if (compare(a[ai], b[bi]) <= 0) {
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
  entry: ScoredEntry
  sourceIdx: number
  resultIdx: number
}

function heapMergeScoredEntries(arrays: ScoredEntry[][], limit: number, compare: EntryComparator): ScoredEntry[] {
  const heap: ScoredHeapNode[] = []
  const nodeFirst = (a: ScoredHeapNode, b: ScoredHeapNode): boolean => compare(a.entry, b.entry) < 0

  for (let i = 0; i < arrays.length; i++) {
    if (arrays[i].length > 0) {
      pushScoredHeap(heap, { entry: arrays[i][0], sourceIdx: i, resultIdx: 0 }, nodeFirst)
    }
  }

  const result: ScoredEntry[] = []

  while (heap.length > 0 && result.length < limit) {
    const top = popScoredHeap(heap, nodeFirst)
    result.push(top.entry)

    const nextIdx = top.resultIdx + 1
    if (nextIdx < arrays[top.sourceIdx].length) {
      pushScoredHeap(
        heap,
        { entry: arrays[top.sourceIdx][nextIdx], sourceIdx: top.sourceIdx, resultIdx: nextIdx },
        nodeFirst,
      )
    }
  }

  return result
}

function pushScoredHeap(
  heap: ScoredHeapNode[],
  node: ScoredHeapNode,
  nodeFirst: (a: ScoredHeapNode, b: ScoredHeapNode) => boolean,
): void {
  heap.push(node)
  let idx = heap.length - 1

  while (idx > 0) {
    const parentIdx = (idx - 1) >> 1
    if (nodeFirst(heap[idx], heap[parentIdx])) {
      const tmp = heap[idx]
      heap[idx] = heap[parentIdx]
      heap[parentIdx] = tmp
      idx = parentIdx
    } else {
      break
    }
  }
}

function popScoredHeap(
  heap: ScoredHeapNode[],
  nodeFirst: (a: ScoredHeapNode, b: ScoredHeapNode) => boolean,
): ScoredHeapNode {
  const top = heap[0]
  const last = heap.pop()

  if (heap.length > 0 && last !== undefined) {
    heap[0] = last
    let idx = 0

    for (;;) {
      const left = 2 * idx + 1
      const right = 2 * idx + 2
      let first = idx

      if (left < heap.length && nodeFirst(heap[left], heap[first])) {
        first = left
      }
      if (right < heap.length && nodeFirst(heap[right], heap[first])) {
        first = right
      }

      if (first !== idx) {
        const tmp = heap[idx]
        heap[idx] = heap[first]
        heap[first] = tmp
        idx = first
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
      return compareCodePoints(a.value, b.value)
    })

    result[field] = buckets.slice(0, maxBuckets)
  }

  return result
}
