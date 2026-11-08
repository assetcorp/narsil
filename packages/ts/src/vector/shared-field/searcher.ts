import {
  addToOrdinalFilter,
  admissionAt,
  createOrdinalFilter,
  ErrorCodes,
  MAX_RENUMBERED_SEARCH_ATTEMPTS,
  magnitude,
  NarsilError,
  nativeScoresOf,
  noteFallback,
  ordinalFilterForSubsets,
  ordinalFilterHas,
  ordinalFilterValues,
  STORE_ORDINAL_LAYOUT_GENERATION,
  storePinsOf,
  toDistance,
  toScore,
  writeSequenceOf,
  writeSequenceWords,
} from '#platform/vector-host'
import { createBoundedMaxHeap } from '../../core/heap'
import type { SearchClock } from '../../core/search-clock'
import type { OrdinalAdmission } from '../admission'
import type { VectorMetric } from '../brute-force'
import type { OrdinalSpace } from '../filter-ordinals'
import type { OrdinalFilter } from '../ordinal-filter'
import { highScoreFirst, mergeResults } from '../vector-index/merge-results'
import type {
  VectorScoredResult,
  VectorSearcher,
  VectorSearchOptions,
  VectorSearchOutcome,
} from '../vector-index/shared'
import type { SharedVectorStoreView } from '../vector-store/view'
import { readStoreFlags } from './store-flags'
import type { SharedVectorFieldView } from './view'

export interface SharedVectorSearcherOptions {
  /** This names the vector field the view belongs to. */
  fieldName: string
  /** This is the thread's open view over the field. */
  view: SharedVectorFieldView
  /** Reports whether the text copy on this thread still holds a document. */
  holdsDocument: (docId: string) => boolean
}

interface Candidates {
  ordinals: number[]
  docIds: string[]
}

interface ScannedResults {
  results: VectorScoredResult[]
  matched: number
}

interface FieldOutcome extends VectorSearchOutcome {
  resolvedEveryHit: boolean
}

function* storeOrdinals(store: SharedVectorStoreView): Iterable<number> {
  const slots = store.slots
  for (let ordinal = 0; ordinal < slots; ordinal++) yield ordinal
}

function distancesInTypeScript(
  store: SharedVectorStoreView,
  query: Float32Array,
  metric: VectorMetric,
  ordinals: number[],
  admission: OrdinalAdmission,
  clock: SearchClock | undefined,
): Float64Array {
  noteFallback('score')
  const arenaQuery = store.prepareQueryArena(query)
  const queryMagnitude = arenaQuery ? arenaQuery.magnitude : magnitude(query)
  const distances = new Float64Array(ordinals.length).fill(Number.POSITIVE_INFINITY)
  for (let i = 0; i < ordinals.length; i++) {
    if (clock !== undefined) clock.tick(query.length)
    if (!admission.admits(ordinals[i])) continue
    if (arenaQuery) {
      distances[i] = store.distanceFromArena(arenaQuery, ordinals[i], metric)
      continue
    }
    const entry = store.entryForOrdinal(ordinals[i])
    if (entry) distances[i] = toDistance(query, entry.vector, queryMagnitude, entry.magnitude, metric)
  }
  return distances
}

interface CandidateScan {
  store: SharedVectorStoreView
  query: Float32Array
  k: number
  metric: VectorMetric
  minSimilarity: number
  admission: OrdinalAdmission
  clock: SearchClock | undefined
}

function scoreCandidates(scan: CandidateScan, candidates: Candidates): ScannedResults {
  const { store, query, k, metric, minSimilarity, admission, clock } = scan
  const { ordinals, docIds } = candidates
  if (ordinals.length === 0) return { results: [], matched: 0 }
  clock?.check()
  const distances =
    nativeScoresOf(store.handles, query, metric, ordinals, admission.pin) ??
    distancesInTypeScript(store, query, metric, ordinals, admission, clock)
  clock?.check()
  const heap = createBoundedMaxHeap<VectorScoredResult>(highScoreFirst, k)
  let matched = 0
  for (let i = 0; i < ordinals.length; i++) {
    if (distances[i] === Number.POSITIVE_INFINITY) continue
    const score = toScore(distances[i], metric)
    if (score < minSimilarity) continue
    matched++
    heap.push({ docId: docIds[i], score, ordinal: ordinals[i] })
  }
  return { results: heap.toSortedArray().reverse(), matched }
}

export function createSharedVectorSearcher(options: SharedVectorSearcherOptions): VectorSearcher {
  const { fieldName, view, holdsDocument } = options
  const flags = readStoreFlags(view.store)

  function ordinalLayoutGeneration(): number {
    return Atomics.load(view.store.handles.header, STORE_ORDINAL_LAYOUT_GENERATION)
  }

  function ordinalSpace(admission?: OrdinalAdmission): OrdinalSpace {
    const store = view.store
    const layoutGeneration = ordinalLayoutGeneration()
    let retained: Map<string, number> | undefined
    function ordinalOf(docId: string): number | undefined {
      const current = view.ordinalOf(docId)
      if (admission === undefined || (current !== undefined && admission.admits(current))) return current
      if (retained === undefined) {
        retained = new Map()
        for (let ordinal = 0; ordinal < store.slots; ordinal++) {
          const id = admission.docIdOf(ordinal)
          if (id !== undefined) retained.set(id, ordinal)
        }
      }
      return retained.get(docId)
    }
    return {
      fieldName,
      layoutGeneration: admission === undefined ? layoutGeneration : -admission.pin - 1,
      slots: store.slots,
      header: store.handles.header,
      ordinalOf,
      holdsCurrentOrdinal: ordinal =>
        admission === undefined
          ? store.holdsOrdinal(ordinal) && store.partitionAt(ordinal) !== undefined
          : admission.admits(ordinal),
      isRemoved: ordinal => (admission === undefined ? flags.isRemoved(ordinal) : !admission.admits(ordinal)),
    }
  }

  function filterForPartitions(allowed: ReadonlySet<number>, admission?: OrdinalAdmission): OrdinalFilter {
    const slots = view.store.slots
    const filter = createOrdinalFilter(slots)
    for (let ordinal = 0; ordinal < slots; ordinal++) {
      const partition = view.store.partitionAt(ordinal)
      if (partition === undefined || !allowed.has(partition)) continue
      if (
        admission === undefined
          ? !view.store.holdsOrdinal(ordinal) || flags.isRemoved(ordinal)
          : !admission.admits(ordinal)
      )
        continue
      addToOrdinalFilter(filter, ordinal)
    }
    return filter
  }

  function filterFor(searchOptions: VectorSearchOptions, admission?: OrdinalAdmission): OrdinalFilter | undefined {
    if (searchOptions.filterSubsets !== undefined) {
      return ordinalFilterForSubsets(searchOptions.filterSubsets, ordinalSpace(admission))
    }
    if (searchOptions.filterPartitions !== undefined)
      return filterForPartitions(searchOptions.filterPartitions, admission)
    return undefined
  }

  function candidatesOf(
    ordinals: Iterable<number>,
    filter: OrdinalFilter | undefined,
    admission: OrdinalAdmission,
  ): Candidates {
    const candidates: Candidates = { ordinals: [], docIds: [] }
    for (const ordinal of ordinals) {
      if (filter !== undefined && !ordinalFilterHas(filter, ordinal)) continue
      const docId = admission.docIdOf(ordinal)
      if (docId === undefined) continue
      candidates.ordinals.push(ordinal)
      candidates.docIds.push(docId)
    }
    return candidates
  }

  function answerOf(outcome: FieldOutcome): VectorSearchOutcome {
    const results = outcome.results.filter(result => holdsDocument(result.docId))
    const holdsEveryHit = outcome.resolvedEveryHit && results.length === outcome.results.length
    return { results, matched: outcome.matched, matchedExact: outcome.matchedExact && holdsEveryHit }
  }

  function scanned(scan: ScannedResults): FieldOutcome {
    return { results: scan.results, matched: scan.matched, matchedExact: true, resolvedEveryHit: true }
  }

  function search(
    query: Float32Array,
    k: number,
    searchOptions: VectorSearchOptions,
    filter: OrdinalFilter | undefined,
    admission: OrdinalAdmission,
  ): FieldOutcome {
    const { metric, minSimilarity, efSearch, oversample, rescoreWindow } = searchOptions
    const clock = searchOptions.clock
    const scan: CandidateScan = { store: view.store, query, k, metric, minSimilarity, admission, clock }
    const empty: FieldOutcome = { results: [], matched: 0, matchedExact: true, resolvedEveryHit: true }
    const liveDocuments = flags.liveDocuments()
    if (liveDocuments <= 0) return empty
    if (filter !== undefined && filter.count === 0) return empty

    function fetched(results: VectorScoredResult[], resolvedEveryHit: boolean): FieldOutcome {
      if (minSimilarity === Number.NEGATIVE_INFINITY) {
        const matched = filter === undefined ? liveDocuments : filter.count
        return { results, matched, matchedExact: true, resolvedEveryHit }
      }
      return { results, matched: results.length, matchedExact: false, resolvedEveryHit }
    }

    if (k <= 0) return fetched([], true)
    const graph = view.graph
    if (graph === null) {
      const ordinals = filter === undefined ? storeOrdinals(view.store) : ordinalFilterValues(filter)
      return scanned(scoreCandidates(scan, candidatesOf(ordinals, filter, admission)))
    }
    if (filter !== undefined) {
      const graphLiveSize = view.liveSize
      const selectivity = graphLiveSize > 0 ? filter.count / graphLiveSize : 1
      if (selectivity < view.handles.filterThreshold) {
        return scanned(scoreCandidates(scan, candidatesOf(ordinalFilterValues(filter), filter, admission)))
      }
    }

    const unplaced = flags.unplacedOrdinals()
    let resolvedEveryHit = true
    const graphResults: VectorScoredResult[] = []
    for (const hit of view.searchOrdinals(query, k, metric, minSimilarity, {
      filter,
      efSearch,
      oversample,
      rescoreWindow,
      clock,
      admission,
    })) {
      const docId = admission.docIdOf(hit.ord)
      if (docId === undefined) {
        resolvedEveryHit = false
        continue
      }
      graphResults.push({ docId, score: hit.score, ordinal: hit.ord })
    }
    if (unplaced.length === 0) return fetched(graphResults, resolvedEveryHit)
    const unplacedScan = scoreCandidates(scan, candidatesOf(unplaced, filter, admission))
    return fetched(mergeResults(graphResults, unplacedScan.results, k), resolvedEveryHit)
  }

  function searchAtOnePin(query: Float32Array, k: number, searchOptions: VectorSearchOptions): FieldOutcome {
    const held = searchOptions.admission
    if (held !== undefined) {
      const filter = filterFor(searchOptions, held)
      const sequence = writeSequenceOf(writeSequenceWords(view.store.handles.header))
      const outcome =
        sequence === held.pin && !view.graphRetired ? search(query, k, searchOptions, filter, held) : undefined
      if (
        outcome !== undefined &&
        writeSequenceOf(writeSequenceWords(view.store.handles.header)) === held.pin &&
        !view.graphRetired
      )
        return outcome
      const ordinals: number[] = []
      for (let ordinal = 0; ordinal < view.store.slots; ordinal++) {
        if (held.admits(ordinal)) ordinals.push(ordinal)
      }
      return scanned(
        scoreCandidates(
          {
            store: view.store,
            query,
            k,
            metric: searchOptions.metric,
            minSimilarity: searchOptions.minSimilarity,
            admission: held,
            clock: searchOptions.clock,
          },
          candidatesOf(ordinals, filter, held),
        ),
      )
    }
    const pins = storePinsOf(view.store)
    const pin = pins.take()
    try {
      return search(query, k, searchOptions, filterFor(searchOptions), admissionAt(view.store, pin))
    } finally {
      pins.release(pin)
    }
  }

  return {
    fieldName,
    dimension: view.handles.dimension,
    partitionsKnown: () => true,
    assignPartitions: () => undefined,
    searchParallel(query, k, searchOptions) {
      if (query.length !== view.handles.dimension) {
        throw new NarsilError(
          ErrorCodes.VECTOR_DIMENSION_MISMATCH,
          `Vector dimension mismatch: expected ${view.handles.dimension}, got ${query.length}`,
          { expected: view.handles.dimension, received: query.length },
        )
      }
      if (searchOptions.admission !== undefined)
        return Promise.resolve(answerOf(searchAtOnePin(query, k, searchOptions)))
      for (let attempt = 1; ; attempt++) {
        const layoutGeneration = ordinalLayoutGeneration()
        const outcome = searchAtOnePin(query, k, searchOptions)
        if (view.graphRetired && searchOptions.admission === undefined) {
          throw new NarsilError(
            ErrorCodes.WORKER_BUSY,
            `The main thread replaced the graph of vector field "${fieldName}" while this thread searched it`,
            { fieldName },
          )
        }
        if (ordinalLayoutGeneration() === layoutGeneration) return Promise.resolve(answerOf(outcome))
        if (attempt >= MAX_RENUMBERED_SEARCH_ATTEMPTS) {
          throw new NarsilError(
            ErrorCodes.WORKER_BUSY,
            `The main thread renumbered the vectors of field "${fieldName}" during each of ${attempt} searches on this thread`,
            { fieldName, attempts: attempt },
          )
        }
      }
    },
  }
}
