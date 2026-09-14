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
import { blockBoundsFor, type PostingBlockBounds } from './block-bounds'
import { PRUNING_REJECTION_SLACK } from './constants'
import { postingColumns } from './posting-columns'
import { markMatched, type ScoreBuffer } from './score-buffer'
import { EMPTY_COMPONENTS } from './scoring'
import { bestSearchable, fieldLengthOf } from './single-term-topk'
import { buildMinHeap, candidateWorse, siftDown, sortSelection, type TopKCandidate } from './top-k-heap'

export interface MultiTermScanTerm {
  token: string
  list: PostingListView
}

export interface MultiTermScanRequest {
  terms: MultiTermScanTerm[]
  docFrequencies: number[]
  totalDocs: number
  bm25Params: BM25Params | undefined
  limit: number
  fieldSearchable: Uint8Array
  fieldBoosts: Float64Array
  fieldAvgLengths: Float64Array
  fieldLengthColumns: ReadonlyArray<Uint32Array | null>
  resolver: InternalIdResolver
  buffer: ScoreBuffer
}

const EXHAUSTED = Number.POSITIVE_INFINITY

interface TermCursor {
  docIds: ArrayLike<number>
  termFrequencies: ArrayLike<number>
  fieldNameIndices: ArrayLike<number>
  deleted: PostingListView['deletedDocs']
  hasDeleted: boolean
  length: number
  docFrequency: number
  bounds: PostingBlockBounds
  blockBound: Float64Array
  maxScore: number
  entry: number
  block: number
  doc: number
}

export function prunableMultiTermLists(
  params: InternalSearchParams,
  index: Pick<InvertedIndexReader, 'lookup'>,
): MultiTermScanTerm[] | null {
  if (params.queryTokens.length < 2) return null
  if (params.prefixExpansion !== undefined) return null
  if (params.exact !== true && (params.tolerance ?? 0) !== 0) return null
  if (params.termMatch !== undefined && params.termMatch !== 'any') return null
  if (params.collectComponents !== false) return null
  if (params.collectMatchedSet !== undefined) return null
  if (params.maxResults === undefined) return null
  if (params.filterBitset !== undefined) return null
  if (!bm25PruningSound(params.bm25Params)) return null

  const terms: MultiTermScanTerm[] = []
  for (const queryToken of params.queryTokens) {
    const list = index.lookup(queryToken.token)
    if (list === undefined) continue
    if (!list.ordered) return null
    terms.push({ token: queryToken.token, list })
  }
  return terms
}

function settle(cursor: TermCursor): void {
  const { docIds, length, deleted, hasDeleted, bounds } = cursor
  while (cursor.entry < length) {
    const internalId = docIds[cursor.entry]
    if (hasDeleted && deleted.has(internalId)) {
      while (cursor.entry < length && docIds[cursor.entry] === internalId) cursor.entry++
      continue
    }
    cursor.doc = internalId
    while (cursor.block < bounds.blockCount && cursor.entry >= bounds.entryEnd[cursor.block]) cursor.block++
    return
  }
  cursor.doc = EXHAUSTED
}

function advance(cursor: TermCursor): void {
  const { docIds, length } = cursor
  const current = cursor.doc
  while (cursor.entry < length && docIds[cursor.entry] === current) cursor.entry++
  settle(cursor)
}

function seek(cursor: TermCursor, target: number): void {
  if (cursor.doc >= target) return
  const { docIds, length } = cursor
  let low = cursor.entry
  let high = low + 1
  let step = 2
  while (high < length && docIds[high] < target) {
    low = high
    high = low + step
    step *= 2
  }
  if (high > length) high = length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (docIds[middle] < target) low = middle + 1
    else high = middle
  }
  cursor.entry = low
  settle(cursor)
}

function openCursor(term: MultiTermScanTerm, docFrequency: number, request: MultiTermScanRequest): TermCursor {
  const { fieldSearchable, fieldBoosts, fieldAvgLengths, fieldLengthColumns, totalDocs, bm25Params } = request
  const columns = postingColumns(term.list)
  const bounds = blockBoundsFor(term.list, fieldLengthColumns)
  const maxBoost = bestSearchable(fieldSearchable, fieldBoosts)
  const maxAverageLength = bestSearchable(fieldSearchable, fieldAvgLengths)
  const blockBound = new Float64Array(bounds.blockCount)
  let maxScore = 0
  for (let block = 0; block < bounds.blockCount; block++) {
    const bestEntry = computeBM25(
      bounds.maxTermFrequency[block],
      docFrequency,
      totalDocs,
      bounds.minFieldLength[block],
      maxAverageLength,
      bm25Params,
    )
    blockBound[block] = bestEntry * maxBoost * bounds.maxEntriesPerDocument[block]
    if (blockBound[block] > maxScore) maxScore = blockBound[block]
  }
  const cursor: TermCursor = {
    docIds: columns.docIds,
    termFrequencies: columns.termFrequencies,
    fieldNameIndices: columns.fieldNameIndices,
    deleted: columns.deletedDocs,
    hasDeleted: columns.hasDeleted,
    length: columns.count,
    docFrequency,
    bounds,
    blockBound,
    maxScore,
    entry: 0,
    block: 0,
    doc: EXHAUSTED,
  }
  settle(cursor)
  return cursor
}

function addRunScore(cursor: TermCursor, request: MultiTermScanRequest, score: number): number {
  const { fieldSearchable, fieldBoosts, fieldAvgLengths, fieldLengthColumns, totalDocs, bm25Params } = request
  const { docIds, length, doc } = cursor
  let total = score
  for (let entry = cursor.entry; entry < length && docIds[entry] === doc; entry++) {
    const fieldIndex = cursor.fieldNameIndices[entry]
    if (fieldSearchable[fieldIndex] !== 1) continue
    const fieldLength = fieldLengthOf(fieldLengthColumns, fieldIndex, doc, fieldAvgLengths[fieldIndex])
    total +=
      computeBM25(
        cursor.termFrequencies[entry],
        cursor.docFrequency,
        totalDocs,
        fieldLength,
        fieldAvgLengths[fieldIndex],
        bm25Params,
      ) * fieldBoosts[fieldIndex]
  }
  return total
}

function countMatches(cursors: TermCursor[], buffer: ScoreBuffer, fieldSearchable: Uint8Array): number {
  for (const cursor of cursors) {
    const { docIds, fieldNameIndices, length, deleted, hasDeleted } = cursor
    for (let entry = 0; entry < length; entry++) {
      if (fieldSearchable[fieldNameIndices[entry]] !== 1) continue
      const internalId = docIds[entry]
      if (hasDeleted && deleted.has(internalId)) continue
      markMatched(buffer, internalId)
    }
  }
  return buffer.touchedCount
}

function exactScore(cursors: TermCursor[], candidate: number, request: MultiTermScanRequest): number | null {
  const { fieldSearchable, fieldBoosts, fieldAvgLengths, fieldLengthColumns, totalDocs, bm25Params } = request
  let score = 0
  let matched = false
  for (const cursor of cursors) {
    if (cursor.doc !== candidate) continue
    const { docIds, length } = cursor
    for (let entry = cursor.entry; entry < length && docIds[entry] === candidate; entry++) {
      const fieldIndex = cursor.fieldNameIndices[entry]
      if (fieldSearchable[fieldIndex] !== 1) continue
      matched = true
      const fieldLength = fieldLengthOf(fieldLengthColumns, fieldIndex, candidate, fieldAvgLengths[fieldIndex])
      score +=
        computeBM25(
          cursor.termFrequencies[entry],
          cursor.docFrequency,
          totalDocs,
          fieldLength,
          fieldAvgLengths[fieldIndex],
          bm25Params,
        ) * fieldBoosts[fieldIndex]
    }
  }
  return matched ? score : null
}

function pageFromHeap(heap: TopKCandidate[]): ScoredDocument[] {
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
  return scored
}

export function multiTermTopK(request: MultiTermScanRequest): InternalSearchResult {
  const { terms, docFrequencies, limit, resolver, buffer } = request
  const wanted = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  const cursors = terms.map((term, index) => openCursor(term, docFrequencies[index], request))
  const totalMatched = countMatches(cursors, buffer, request.fieldSearchable)
  if (wanted === 0 || cursors.length === 0) return { scored: [], totalMatched }

  const order = cursors.map((_, index) => index).sort((a, b) => cursors[a].maxScore - cursors[b].maxScore)
  const prefixMax = new Float64Array(order.length)
  for (let position = 0; position < order.length; position++) {
    prefixMax[position] = (position === 0 ? 0 : prefixMax[position - 1]) + cursors[order[position]].maxScore
  }

  const heap: TopKCandidate[] = []
  let full = false
  let threshold = 0
  let firstEssential = 0

  for (;;) {
    while (firstEssential < order.length && prefixMax[firstEssential] < threshold) firstEssential++
    if (firstEssential === order.length) break

    let candidate = EXHAUSTED
    for (let position = firstEssential; position < order.length; position++) {
      const doc = cursors[order[position]].doc
      if (doc < candidate) candidate = doc
    }
    if (candidate === EXHAUSTED) break

    const nonEssentialMax = firstEssential === 0 ? 0 : prefixMax[firstEssential - 1]
    let bound = nonEssentialMax
    for (let position = firstEssential; position < order.length; position++) {
      const cursor = cursors[order[position]]
      if (cursor.doc === candidate) bound += cursor.blockBound[cursor.block]
    }

    let rejected = full && bound < threshold
    if (!rejected) {
      let partial = 0
      for (let position = firstEssential; position < order.length; position++) {
        const cursor = cursors[order[position]]
        if (cursor.doc === candidate) partial = addRunScore(cursor, request, partial)
      }
      let remaining = nonEssentialMax
      const rejectBelow = threshold - threshold * PRUNING_REJECTION_SLACK
      for (let position = firstEssential - 1; position >= 0; position--) {
        if (full && partial + remaining < rejectBelow) {
          rejected = true
          break
        }
        const cursor = cursors[order[position]]
        seek(cursor, candidate)
        if (cursor.doc === candidate) partial = addRunScore(cursor, request, partial)
        remaining -= cursor.maxScore
      }
    }

    const score = rejected ? null : exactScore(cursors, candidate, request)
    if (score !== null) {
      if (!(full && score < threshold)) {
        const externalId = resolver.toExternal(candidate)
        if (externalId !== undefined) {
          const entry: TopKCandidate = { internalId: candidate, externalId, score }
          if (!full) {
            heap.push(entry)
            if (heap.length === wanted) {
              buildMinHeap(heap)
              full = true
              threshold = heap[0].score
            }
          } else if (candidateWorse(heap[0], entry)) {
            heap[0] = entry
            siftDown(heap, 0)
            threshold = heap[0].score
          }
        }
      }
    }

    for (const cursor of cursors) {
      if (cursor.doc === candidate) advance(cursor)
    }
  }

  return { scored: pageFromHeap(heap), totalMatched }
}
