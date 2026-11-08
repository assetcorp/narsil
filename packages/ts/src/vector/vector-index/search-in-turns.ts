import {
  filterForOptions,
  holdWritesAndBackgroundWork,
  liveSize,
  SEARCH_ATTEMPTS_BEFORE_HOLDING_WRITES,
  SEARCH_REFILL_RESERVE,
  SEARCH_SCAN_CHUNK_VECTORS,
  STORE_ORDINAL_LAYOUT_GENERATION,
  turnIsSpent,
  turnsAreBudgeted,
  yieldTurn,
} from '#platform/vector-host'
import type { OrdinalFilter } from '../ordinal-filter'
import { mergeResults } from './merge-results'
import {
  bruteForceSearch,
  createScanTally,
  fetchedOutcome,
  graphResultsOf,
  liveOrdinalOf,
  type ScanRequest,
  scoreCandidates,
  searchSteps,
  searchWithFilter,
} from './search'
import { type SearchWatch, watchingSearch } from './search-writes'
import type { VectorIndexState, VectorScoredResult, VectorSearchOptions, VectorSearchOutcome } from './shared'

interface ScanInTurns {
  kept: VectorScoredResult[]
  matched: number
  bestDiscardedScore: number
}

interface SearchPass {
  outcome: VectorSearchOutcome
  graphResults: VectorScoredResult[] | null
  scan: ScanInTurns | null
}

interface ScanChunk {
  docIds: string[]
  ordinals: Int32Array
}

export function layoutGeneration(state: VectorIndexState): number {
  return Atomics.load(state.store.handles.header, STORE_ORDINAL_LAYOUT_GENERATION)
}

async function scanInTurns(
  state: VectorIndexState,
  query: Float32Array,
  capacity: number,
  options: VectorSearchOptions,
  request: ScanRequest,
  chunkOfThisSearch: ScanChunk,
): Promise<ScanInTurns> {
  const tally = createScanTally(capacity)
  const { docIds, ordinals } = chunkOfThisSearch
  let length = 0
  const scoreChunk = (): void => {
    const chunk = length === SEARCH_SCAN_CHUNK_VECTORS ? ordinals : ordinals.subarray(0, length)
    scoreCandidates(state, query, options.metric, options.minSimilarity, docIds, chunk, tally)
    length = 0
  }
  for (const docId of request.candidates) {
    const ordinal = liveOrdinalOf(state, docId, request.filter)
    if (ordinal === undefined) continue
    docIds[length] = docId
    ordinals[length] = ordinal
    length++
    if (length < SEARCH_SCAN_CHUNK_VECTORS) continue
    scoreChunk()
    if (turnIsSpent()) await yieldTurn()
  }
  if (length > 0) scoreChunk()
  return {
    kept: tally.best.toSortedArray().reverse(),
    matched: tally.matched,
    bestDiscardedScore: tally.bestDiscardedScore,
  }
}

async function passInTurns(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
  filter: OrdinalFilter | undefined,
  chunk: ScanChunk,
): Promise<SearchPass> {
  const steps = searchSteps(state, query, k, options, filter)
  let graphResults: VectorScoredResult[] | null = null
  let scan: ScanInTurns | null = null
  let step = steps.next()
  while (step.done !== true) {
    graphResults = step.value.graphResults
    scan = await scanInTurns(state, query, k + SEARCH_REFILL_RESERVE, options, step.value, chunk)
    step = steps.next({ results: scan.kept.slice(0, k), matched: scan.matched })
  }
  return { outcome: step.value, graphResults, scan }
}

function rescoredSinceTheScan(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
  filter: OrdinalFilter | undefined,
  watch: SearchWatch,
): VectorScoredResult[] {
  const touched = new Set(watch.written)
  for (const docId of watch.leftBuffer) touched.add(docId)
  return bruteForceSearch(state, query, k, options.metric, options.minSimilarity, touched, filter).results
}

function outrunsEveryDiscard(results: VectorScoredResult[], k: number, bestDiscardedScore: number): boolean {
  if (bestDiscardedScore === Number.NEGATIVE_INFINITY) return true
  const lowest = results[k - 1]
  return lowest !== undefined && lowest.score > bestDiscardedScore
}

function settledOutcome(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
  pass: SearchPass,
  watch: SearchWatch,
): VectorSearchOutcome | null {
  const { written, leftBuffer } = watch
  const { scan, graphResults } = pass
  if (scan === null || (written.size === 0 && leftBuffer.size === 0)) return pass.outcome
  if (graphResults === null) return written.size === 0 ? pass.outcome : null

  const filter = filterForOptions(state, options)
  const graphTouched = graphResults.some(result => written.has(result.docId))
  const graphPart = graphTouched ? graphResultsOf(state, query, k, options, filter) : graphResults
  const survivors = scan.kept.filter(result => !written.has(result.docId))
  const rescored = rescoredSinceTheScan(state, query, k, options, filter, watch)
  const results = mergeResults(graphPart, mergeResults(survivors, rescored, k), k)
  const refilled = survivors.length < scan.kept.length
  if (refilled && !outrunsEveryDiscard(results, k, scan.bestDiscardedScore)) return null
  return fetchedOutcome(state, results, options.minSimilarity, filter)
}

function attemptInTurns(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
  filter: OrdinalFilter | undefined,
  chunk: ScanChunk,
): Promise<VectorSearchOutcome | null> {
  const generation = liveSize(state) === 0 ? null : layoutGeneration(state)
  return watchingSearch(state, async watch => {
    const pass = await passInTurns(state, query, k, options, filter, chunk)
    if (state.disposed) return pass.outcome
    if (generation !== null && layoutGeneration(state) !== generation) return null
    return settledOutcome(state, query, k, options, pass, watch)
  })
}

async function searchWithFilterInTurns(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
  filter: OrdinalFilter | undefined,
): Promise<VectorSearchOutcome> {
  let current = filter
  const chunk: ScanChunk = { docIds: [], ordinals: new Int32Array(SEARCH_SCAN_CHUNK_VECTORS) }
  for (let attempt = 1; ; attempt++) {
    const search = (): Promise<VectorSearchOutcome | null> => attemptInTurns(state, query, k, options, current, chunk)
    const outcome =
      attempt <= SEARCH_ATTEMPTS_BEFORE_HOLDING_WRITES ? await search() : await holdWritesAndBackgroundWork(search)
    if (outcome !== null) return outcome
    current = filterForOptions(state, options)
  }
}

export function searchFiltered(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
  filter: OrdinalFilter | undefined,
): VectorSearchOutcome | Promise<VectorSearchOutcome> {
  if (turnsAreBudgeted) return searchWithFilterInTurns(state, query, k, options, filter)
  return searchWithFilter(state, query, k, options, filter)
}
