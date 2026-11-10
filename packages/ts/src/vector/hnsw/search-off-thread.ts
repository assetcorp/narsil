import type { VectorMetric } from '../brute-force'
import { type NativeField, nativeFieldFor } from '../native/field'
import { nativeMetricCode } from '../native/store'
import { type ThreadedNativeCore, threadedNativeCore, withNativeThreadSlot } from '../native/thread-slots'
import { NATIVE_OK } from '../native/types'
import type { OrdinalFilter } from '../ordinal-filter'
import { ordinalFilterHas } from '../ordinal-membership'
import { magnitude } from '../similarity'
import { STORE_ORDINAL_LAYOUT_GENERATION } from '../vector-store/handles'
import {
  bestResolvedHits,
  endOfRescored,
  estimatedHits,
  type GraphSearchOptions,
  graphIsEmpty,
  type OrdinalHit,
  type ResolvedHit,
  requireQueryDimension,
  rescoreWithFullPrecision,
  searchDepths,
} from './search'
import { type HNSWSearchState, toScore } from './shared'
import type { DistanceList } from './workspace'

interface OffThreadRescore {
  state: HNSWSearchState
  core: ThreadedNativeCore
  field: NativeField
  candidates: DistanceList
  query: Float32Array
  depth: number
  metric: VectorMetric
  minSimilarity: number
  filter: OrdinalFilter | undefined
  pin: number
  slot: number
}

function chosenOrdinals(candidates: DistanceList, depth: number, filter: OrdinalFilter | undefined): Int32Array {
  const nearest = Math.min(candidates.size, depth)
  const ordinals = new Int32Array(nearest)
  let kept = 0
  for (let i = 0; i < candidates.size && kept < nearest; i++) {
    const ord = candidates.ords[i]
    if (filter && !ordinalFilterHas(filter, ord)) continue
    ordinals[kept++] = ord
  }
  return ordinals.subarray(0, kept)
}

function onFullPrecision(rescore: OffThreadRescore): OrdinalHit[] {
  const { state, candidates, query, depth, metric, minSimilarity, filter } = rescore
  const arena = state.store.prepareQueryArena(query)
  const qMag = arena ? arena.magnitude : magnitude(query)
  return rescoreWithFullPrecision(state, candidates, query, qMag, arena, depth, metric, minSimilarity, filter)
}

async function rescoredOffThread(rescore: OffThreadRescore): Promise<OrdinalHit[]> {
  const { core, field, candidates, query, depth, metric, minSimilarity, filter, pin, slot } = rescore
  const ordinals = chosenOrdinals(candidates, depth, filter)
  if (ordinals.length === 0) return []
  let scored: Awaited<ReturnType<ThreadedNativeCore['scoreAsync']>>
  try {
    const code = nativeMetricCode(metric)
    scored = await core.scoreAsync(field.store.handle, query, code, ordinals, ordinals.length, pin, slot)
  } catch {
    return onFullPrecision(rescore)
  }
  if (scored.status !== NATIVE_OK) return onFullPrecision(rescore)
  const hits: OrdinalHit[] = []
  for (let i = 0; i < ordinals.length; i++) {
    const distance = scored.distances[i]
    if (distance === Number.POSITIVE_INFINITY) continue
    const score = toScore(distance, metric)
    if (score < minSimilarity) continue
    hits.push({ ord: ordinals[i], score })
  }
  return hits
}

export async function searchOffThread(
  state: HNSWSearchState,
  docIdOf: (ordinal: number) => string | undefined,
  query: Float32Array,
  k: number,
  metric: VectorMetric,
  minSimilarity: number,
  options: GraphSearchOptions,
): Promise<ResolvedHit[] | null> {
  requireQueryDimension(state, query)
  if (graphIsEmpty(state)) return []
  const core = threadedNativeCore()
  const field = nativeFieldFor(state)
  const admission = options.admission
  if (core === null || field === null || admission === undefined) return null
  const { ef, depth, useQuantized } = searchDepths(state, k, options)
  const filter = options.filter
  const pin = admission.pin
  const header = state.store.handles.header
  const generation = Atomics.load(header, STORE_ORDINAL_LAYOUT_GENERATION)
  const cachedDocIdOf = (ordinal: number): string | undefined => {
    if (!admission.admits(ordinal)) return undefined
    return docIdOf(ordinal) ?? admission.docIdOf(ordinal)
  }
  const resolveHits = (hits: OrdinalHit[]): ResolvedHit[] =>
    bestResolvedHits(
      hits,
      k,
      Atomics.load(header, STORE_ORDINAL_LAYOUT_GENERATION) === generation ? cachedDocIdOf : admission.docIdOf,
    )

  return withNativeThreadSlot(async slot => {
    let found: Awaited<ReturnType<ThreadedNativeCore['searchAsync']>>
    try {
      found = await core.searchAsync(
        field.graph,
        field.store.handle,
        query,
        nativeMetricCode(metric),
        ef,
        pin,
        slot,
        filter === undefined ? null : filter.bits,
      )
    } catch {
      return null
    }
    if (found.count < 0) return null
    const candidates: DistanceList = { ords: found.ordinals, distances: found.distances, size: found.count }
    if (!useQuantized) return resolveHits(estimatedHits(candidates, 0, metric, minSimilarity, filter))

    const rescored = await rescoredOffThread({
      state,
      core,
      field,
      candidates,
      query,
      depth,
      metric,
      minSimilarity,
      filter,
      pin,
      slot,
    })
    if (options.rescoreWindow === undefined || minSimilarity !== Number.NEGATIVE_INFINITY) {
      return resolveHits(rescored)
    }
    const rest = endOfRescored(candidates, depth, filter)
    return resolveHits(rescored.concat(estimatedHits(candidates, rest, metric, minSimilarity, filter)))
  })
}
