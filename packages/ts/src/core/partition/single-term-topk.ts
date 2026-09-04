import type {
  InternalIdResolver,
  InternalSearchParams,
  InternalSearchResult,
  PostingListView,
  ScoredDocument,
} from '../../types/internal'
import type { BM25Params } from '../../types/schema'
import type { InvertedIndexReader } from '../inverted-index'
import { bm25PruningSound, computeBM25 } from '../scorer'
import { blockBoundsFor } from './block-bounds'
import { postingColumns } from './posting-columns'
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
 * Decides whether a query may run on the pruned single-term scan, returning
 * the term's posting list when it may and null when the query needs the full
 * term-at-a-time loop. The scan handles exactly one unexpanded term scored
 * over every searchable field with a bounded page, on an ordered list, under
 * BM25 parameters whose block bound stays a true upper bound.
 *
 * @param params - The resolved search parameters.
 * @param index - The inverted index holding the term's postings.
 * @returns The posting list to scan, or null when the query must fall back.
 */
export function prunableSingleTermList(
  params: InternalSearchParams,
  index: Pick<InvertedIndexReader, 'lookup'>,
): PostingListView | null {
  if (params.queryTokens.length !== 1) return null
  if (params.prefixExpansion !== undefined) return null
  if (params.exact !== true && (params.tolerance ?? 0) !== 0) return null
  if (params.termMatch !== undefined && params.termMatch !== 'any') return null
  if (params.collectComponents !== false) return null
  if (params.collectMatchedSet !== undefined) return null
  if (params.maxResults === undefined) return null
  if (params.fields !== undefined) return null
  if (params.filterBitset !== undefined) return null
  if (!bm25PruningSound(params.bm25Params)) return null

  const list = index.lookup(params.queryTokens[0].token)

  if (list === undefined) return null
  if (!list.ordered) return null

  return list
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
  const { docIds, termFrequencies, fieldNameIndices, deletedDocs: deleted, hasDeleted } = postingColumns(list)

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
      const internalId = docIds[entry]
      if (hasDeleted && deleted.has(internalId)) {
        while (entry < end && docIds[entry] === internalId) entry++
        continue
      }
      let score = 0
      let scored = false
      while (entry < end && docIds[entry] === internalId) {
        const fieldIndex = fieldNameIndices[entry]
        if (fieldSearchable[fieldIndex] === 1) {
          const fieldLength = fieldLengthOf(fieldLengthColumns, fieldIndex, internalId, fieldAvgLengths[fieldIndex])
          score +=
            computeBM25(
              termFrequencies[entry],
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
