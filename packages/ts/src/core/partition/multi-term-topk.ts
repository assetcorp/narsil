import type {
  InternalIdResolver,
  InternalSearchParams,
  InternalSearchResult,
  PostingListView,
  ScoredDocument,
} from '../../types/internal'
import type { BM25Params } from '../../types/schema'
import type { InvertedIndexReader } from '../inverted-index'
import { bm25PruningSound, computeBM25WithIDF, computeIDF, resolveBM25Params } from '../scorer'
import { blockBoundsFor } from './block-bounds'
import { PRUNING_REJECTION_SLACK } from './constants'
import { bestSearchable, type FieldScoring, fieldLengthOf } from './field-scoring'
import { type PostingColumns, postingColumns } from './posting-columns'
import { addScore, hasScore, kthBestScore, markCounted, type ScoreBuffer } from './score-buffer'
import { EMPTY_COMPONENTS } from './scoring'
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
  fields: FieldScoring
  resolver: InternalIdResolver
  buffer: ScoreBuffer
}

interface TermScan {
  columns: PostingColumns
  idf: number
  k1: number
  b: number
  scoresAreZero: boolean
  fields: FieldScoring
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

function boostsKeepScoresNonNegative(fields: FieldScoring): boolean {
  for (let fieldIndex = 0; fieldIndex < fields.searchable.length; fieldIndex++) {
    if (fields.searchable[fieldIndex] !== 1) continue
    const boost = fields.boosts[fieldIndex]
    if (!Number.isFinite(boost) || boost < 0) return false
  }
  return true
}

function termUpperBound(scan: TermScan, list: PostingListView, maxBoost: number, maxAverageLength: number): number {
  if (scan.scoresAreZero) return 0
  const bounds = blockBoundsFor(list, scan.fields.lengthColumns)
  let best = 0
  for (let block = 0; block < bounds.blockCount; block++) {
    const bestEntry = computeBM25WithIDF(
      bounds.maxTermFrequency[block],
      scan.idf,
      bounds.minFieldLength[block],
      maxAverageLength,
      scan.k1,
      scan.b,
    )
    const blockBound = bestEntry * maxBoost * bounds.maxEntriesPerDocument[block]
    if (blockBound > best) best = blockBound
  }
  return best
}

function entryScore(scan: TermScan, entry: number, internalId: number): number {
  const { fields, columns } = scan
  const fieldIndex = columns.fieldNameIndices[entry]
  const averageLength = fields.averageLengths[fieldIndex]
  const fieldLength = fieldLengthOf(fields.lengthColumns, fieldIndex, internalId, averageLength)
  const bm25 = scan.scoresAreZero
    ? 0
    : computeBM25WithIDF(columns.termFrequencies[entry], scan.idf, fieldLength, averageLength, scan.k1, scan.b)
  return bm25 * fields.boosts[fieldIndex]
}

function scoreEveryDocument(scan: TermScan, buffer: ScoreBuffer): void {
  const { docIds, fieldNameIndices, deletedDocs, hasDeleted, count } = scan.columns
  const searchable = scan.fields.searchable
  for (let entry = 0; entry < count; entry++) {
    const internalId = docIds[entry]
    if (hasDeleted && deletedDocs.has(internalId)) continue
    if (searchable[fieldNameIndices[entry]] !== 1) continue
    addScore(buffer, internalId, entryScore(scan, entry, internalId))
  }
}

function scoreKnownDocumentsAndCountTheRest(scan: TermScan, buffer: ScoreBuffer): number {
  const { docIds, fieldNameIndices, deletedDocs, hasDeleted, count } = scan.columns
  const searchable = scan.fields.searchable
  let counted = 0
  for (let entry = 0; entry < count; entry++) {
    const internalId = docIds[entry]
    if (hasDeleted && deletedDocs.has(internalId)) continue
    if (searchable[fieldNameIndices[entry]] !== 1) continue
    if (hasScore(buffer, internalId)) addScore(buffer, internalId, entryScore(scan, entry, internalId))
    else if (markCounted(buffer, internalId)) counted++
  }
  return counted
}

function queryOrderScore(scans: TermScan[], internalId: number): number {
  let score = 0
  for (const scan of scans) {
    const { docIds, deletedDocs, hasDeleted, count } = scan.columns
    if (hasDeleted && deletedDocs.has(internalId)) continue
    let low = 0
    let high = count
    while (low < high) {
      const middle = (low + high) >>> 1
      if (docIds[middle] < internalId) low = middle + 1
      else high = middle
    }
    for (let entry = low; entry < count && docIds[entry] === internalId; entry++) {
      if (scan.fields.searchable[scan.columns.fieldNameIndices[entry]] !== 1) continue
      score += entryScore(scan, entry, internalId)
    }
  }
  return score
}

function pageFromBuffer(
  scans: TermScan[],
  buffer: ScoreBuffer,
  selection: Float64Array,
  resolver: InternalIdResolver,
): ScoredDocument[] {
  const approximateKth = kthBestScore(buffer, selection, resolver)
  const gatherFrom = approximateKth - Math.abs(approximateKth) * PRUNING_REJECTION_SLACK
  const heap: TopKCandidate[] = []
  let full = false
  let threshold = 0
  const { touched, touchedCount, scores } = buffer
  for (let index = 0; index < touchedCount; index++) {
    const internalId = touched[index]
    if (scores[internalId] < gatherFrom) continue
    const externalId = resolver.toExternal(internalId)
    if (externalId === undefined) continue
    const score = queryOrderScore(scans, internalId)
    if (full && score < threshold) continue
    const candidate: TopKCandidate = { internalId, externalId, score }
    if (!full) {
      heap.push(candidate)
      if (heap.length === selection.length) {
        buildMinHeap(heap)
        full = true
        threshold = heap[0].score
      }
    } else if (candidateWorse(heap[0], candidate)) {
      heap[0] = candidate
      siftDown(heap, 0)
      threshold = heap[0].score
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
  return scored
}

export function multiTermTopK(request: MultiTermScanRequest): InternalSearchResult | null {
  const { terms, docFrequencies, totalDocs, bm25Params, limit, fields, resolver, buffer } = request
  if (!boostsKeepScoresNonNegative(fields)) return null

  const { k1, b } = resolveBM25Params(bm25Params)
  const scans: TermScan[] = new Array(terms.length)
  for (let term = 0; term < terms.length; term++) {
    const idf = computeIDF(docFrequencies[term], totalDocs)
    if (!(idf >= 0)) return null
    scans[term] = { columns: postingColumns(terms[term].list), idf, k1, b, scoresAreZero: totalDocs === 0, fields }
  }

  const maxBoost = bestSearchable(fields.searchable, fields.boosts)
  const maxAverageLength = bestSearchable(fields.searchable, fields.averageLengths)
  const upperBounds = scans.map((scan, term) => termUpperBound(scan, terms[term].list, maxBoost, maxAverageLength))
  const order = scans.map((_, term) => term).sort((left, right) => upperBounds[right] - upperBounds[left])
  const remainingBound = new Float64Array(order.length + 1)
  for (let position = order.length - 1; position >= 0; position--) {
    remainingBound[position] = remainingBound[position + 1] + upperBounds[order[position]]
  }

  const wanted = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  const selection = new Float64Array(wanted)
  let position = wanted === 0 ? order.length : 0
  for (; position < order.length; position++) {
    const remaining = remainingBound[position]
    if (position > 0 && buffer.touchedCount >= wanted && remaining < remainingBound[0] - remaining) {
      const threshold = kthBestScore(buffer, selection, resolver)
      if (remaining < threshold - threshold * PRUNING_REJECTION_SLACK) break
    }
    scoreEveryDocument(scans[order[position]], buffer)
  }

  let countedOnly = 0
  for (let rest = position; rest < order.length; rest++) {
    countedOnly += scoreKnownDocumentsAndCountTheRest(scans[order[rest]], buffer)
  }

  const totalMatched = buffer.touchedCount + countedOnly
  if (wanted === 0) return { scored: [], totalMatched }
  return { scored: pageFromBuffer(scans, buffer, selection, resolver), totalMatched }
}
