import type { InternalIdResolver, InternalSearchResult, PostingListView, ScoredDocument } from '../../types/internal'
import type { BM25Params } from '../../types/schema'
import { computeBM25 } from '../scorer'
import { blockBoundsFor } from './block-bounds'
import { EMPTY_COMPONENTS } from './scoring'
import { buildMinHeap, candidateWorse, siftDown, sortSelection, type TopKCandidate } from './top-k-heap'

/**
 * Everything the pruned scan reads, gathered by the caller so the scan itself
 * touches no partition state beyond the posting list.
 *
 * @internal
 */
export interface SingleTermScanRequest {
  list: PostingListView
  docFrequency: number
  totalDocs: number
  bm25Params: BM25Params | undefined
  limit: number
  fieldSearchable: Uint8Array
  fieldBoosts: Float64Array
  fieldAvgLengths: Float64Array
  fieldLengthColumns: ReadonlyArray<Uint32Array | null>
  resolver: InternalIdResolver
}

function fieldLengthOf(
  columns: ReadonlyArray<Uint32Array | null>,
  fieldIndex: number,
  internalId: number,
  averageLength: number,
): number {
  const column = fieldIndex < columns.length ? columns[fieldIndex] : null
  if (column === null || internalId >= column.length) return averageLength
  const stored = column[internalId]
  return stored > 0 ? stored : averageLength
}

function bestSearchable(searchable: Uint8Array, values: Float64Array): number {
  let best = 0
  for (let index = 0; index < searchable.length; index++) {
    if (searchable[index] === 1 && values[index] > best) best = values[index]
  }
  return best
}

/**
 * Answers a one-term scored query by walking the term's postings in document
 * order and ruling out whole blocks whose best possible score cannot reach the
 * page. Tombstoned documents are skipped, and every live document is still
 * counted, because a ruled-out block carries the number of live documents it
 * holds, so the reported total stays exact.
 *
 * @param request - The posting list, the scoring inputs, and the page size.
 * @returns The page in descending score order, with the exact number of matching documents.
 */
export function singleTermTopK(request: SingleTermScanRequest): InternalSearchResult {
  const { list, docFrequency, totalDocs, bm25Params, limit, resolver } = request
  const { fieldSearchable, fieldBoosts, fieldAvgLengths, fieldLengthColumns } = request

  const wanted = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  const deleted = list.deletedDocs
  const hasDeleted = deleted.size > 0

  const bounds = blockBoundsFor(list, fieldLengthColumns)
  const maxBoost = bestSearchable(fieldSearchable, fieldBoosts)
  const maxAverageLength = bestSearchable(fieldSearchable, fieldAvgLengths)

  const heap: TopKCandidate[] = []
  let full = false
  let threshold = 0
  let totalMatched = 0

  for (let block = 0; block < bounds.blockCount; block++) {
    const start = block === 0 ? 0 : bounds.entryEnd[block - 1]
    const end = bounds.entryEnd[block]

    if (full) {
      const bestEntry = computeBM25(
        bounds.maxTermFrequency[block],
        docFrequency,
        totalDocs,
        bounds.minFieldLength[block],
        maxAverageLength,
        bm25Params,
      )
      if (bestEntry * maxBoost * bounds.maxEntriesPerDocument[block] < threshold) {
        totalMatched += bounds.documentCount[block]
        continue
      }
    }

    let entry = start
    while (entry < end) {
      const internalId = list.docIds[entry]
      if (hasDeleted && deleted.has(internalId)) {
        while (entry < end && list.docIds[entry] === internalId) entry++
        continue
      }
      let score = 0
      let scored = false
      while (entry < end && list.docIds[entry] === internalId) {
        const fieldIndex = list.fieldNameIndices[entry]
        if (fieldSearchable[fieldIndex] === 1) {
          const fieldLength = fieldLengthOf(fieldLengthColumns, fieldIndex, internalId, fieldAvgLengths[fieldIndex])
          score +=
            computeBM25(
              list.termFrequencies[entry],
              docFrequency,
              totalDocs,
              fieldLength,
              fieldAvgLengths[fieldIndex],
              bm25Params,
            ) * fieldBoosts[fieldIndex]
          scored = true
        }
        entry++
      }
      if (!scored) continue
      totalMatched++

      if (wanted === 0) continue
      if (full && score < threshold) continue
      const externalId = resolver.toExternal(internalId)
      if (externalId === undefined) continue
      const candidate: TopKCandidate = { internalId, externalId, score }

      if (!full) {
        heap.push(candidate)
        if (heap.length === wanted) {
          buildMinHeap(heap)
          full = true
          threshold = heap[0].score
        }
        continue
      }
      if (candidateWorse(heap[0], candidate)) {
        heap[0] = candidate
        siftDown(heap, 0)
        threshold = heap[0].score
      }
    }
  }

  sortSelection(heap)
  const scored: ScoredDocument[] = new Array(heap.length)
  for (let index = 0; index < heap.length; index++) {
    scored[index] = {
      docId: heap[index].externalId,
      score: heap[index].score,
      termFrequencies: EMPTY_COMPONENTS,
      fieldLengths: EMPTY_COMPONENTS,
      idf: EMPTY_COMPONENTS,
    }
  }
  return { scored, totalMatched }
}
