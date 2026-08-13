import type { ScoredDocument } from '../../types/internal'
import { compareCodePoints } from '../ordering'

interface HeapNode {
  score: number
  docId: string
  partitionIdx: number
  resultIdx: number
}

export function kWayMerge(arrays: ScoredDocument[][]): ScoredDocument[] {
  const nonEmpty = arrays.filter(a => a.length > 0)

  if (nonEmpty.length === 0) return []
  if (nonEmpty.length === 1) return nonEmpty[0]

  if (nonEmpty.length <= 4) {
    return sequentialMerge(nonEmpty)
  }

  return heapMerge(nonEmpty)
}

function sequentialMerge(arrays: ScoredDocument[][]): ScoredDocument[] {
  let merged = arrays[0]

  for (let i = 1; i < arrays.length; i++) {
    merged = mergeTwoSorted(merged, arrays[i])
  }

  return merged
}

function mergeTwoSorted(a: ScoredDocument[], b: ScoredDocument[]): ScoredDocument[] {
  const result: ScoredDocument[] = new Array(a.length + b.length)
  let ai = 0
  let bi = 0
  let ri = 0

  while (ai < a.length && bi < b.length) {
    if (
      a[ai].score > b[bi].score ||
      (a[ai].score === b[bi].score && compareCodePoints(a[ai].docId, b[bi].docId) <= 0)
    ) {
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

function heapMerge(arrays: ScoredDocument[][]): ScoredDocument[] {
  const heap: HeapNode[] = []
  let totalSize = 0

  for (let i = 0; i < arrays.length; i++) {
    if (arrays[i].length > 0) {
      totalSize += arrays[i].length
      heapPush(heap, {
        score: arrays[i][0].score,
        docId: arrays[i][0].docId,
        partitionIdx: i,
        resultIdx: 0,
      })
    }
  }

  const result: ScoredDocument[] = new Array(totalSize)
  let writeIdx = 0

  while (heap.length > 0) {
    const top = heapPop(heap)
    result[writeIdx++] = arrays[top.partitionIdx][top.resultIdx]

    const nextIdx = top.resultIdx + 1
    if (nextIdx < arrays[top.partitionIdx].length) {
      const nextDoc = arrays[top.partitionIdx][nextIdx]
      heapPush(heap, {
        score: nextDoc.score,
        docId: nextDoc.docId,
        partitionIdx: top.partitionIdx,
        resultIdx: nextIdx,
      })
    }
  }

  return result
}

function heapNodeGreater(a: HeapNode, b: HeapNode): boolean {
  if (a.score !== b.score) return a.score > b.score
  return compareCodePoints(a.docId, b.docId) < 0
}

function heapPush(heap: HeapNode[], node: HeapNode): void {
  heap.push(node)
  let idx = heap.length - 1

  while (idx > 0) {
    const parentIdx = (idx - 1) >> 1
    if (heapNodeGreater(heap[idx], heap[parentIdx])) {
      const tmp = heap[idx]
      heap[idx] = heap[parentIdx]
      heap[parentIdx] = tmp
      idx = parentIdx
    } else {
      break
    }
  }
}

function heapPop(heap: HeapNode[]): HeapNode {
  const top = heap[0]
  const last = heap.pop() as HeapNode

  if (heap.length > 0) {
    heap[0] = last
    let idx = 0

    while (true) {
      const left = 2 * idx + 1
      const right = 2 * idx + 2
      let largest = idx

      if (left < heap.length && heapNodeGreater(heap[left], heap[largest])) {
        largest = left
      }
      if (right < heap.length && heapNodeGreater(heap[right], heap[largest])) {
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
