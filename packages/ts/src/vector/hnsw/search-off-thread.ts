import type { VectorMetric } from '../brute-force'
import { type NativeField, nativeFieldFor } from '../native/field'
import { nativeMetricCode } from '../native/store'
import { type ThreadedNativeCore, threadedNativeCore, withNativeThreadSlot } from '../native/thread-slots'
import { NATIVE_OK } from '../native/types'
import { type OrdinalFilter, ordinalFilterHas } from '../ordinal-filter'
import { magnitude } from '../similarity'
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
  const { core, field, candidates, query, depth, metric, minSimilarity, filter, slot } = rescore
  const ordinals = chosenOrdinals(candidates, depth, filter)
  if (ordinals.length === 0) return []
  let scored: Awaited<ReturnType<ThreadedNativeCore['scoreAsync']>>
  try {
    scored = await core.scoreAsync(field.store.handle, query, nativeMetricCode(metric), ordinals, ordinals.length, slot)
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
  docIdOf: (ord: number) => string | undefined,
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
  if (core === null || field === null) return null
  const { ef, depth, useQuantized } = searchDepths(state, k, options)
  const filter = options.filter

  return withNativeThreadSlot(async slot => {
    let found: Awaited<ReturnType<ThreadedNativeCore['searchAsync']>>
    try {
      found = await core.searchAsync(
        field.graph,
        field.store.handle,
        query,
        nativeMetricCode(metric),
        ef,
        slot,
        filter === undefined ? null : filter.bits,
      )
    } catch {
      return null
    }
    if (found.count < 0) return null
    const candidates: DistanceList = { ords: found.ordinals, distances: found.distances, size: found.count }
    if (!useQuantized) return bestResolvedHits(estimatedHits(candidates, 0, metric, minSimilarity, filter), k, docIdOf)

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
      slot,
    })
    if (options.rescoreWindow === undefined || minSimilarity !== Number.NEGATIVE_INFINITY) {
      return bestResolvedHits(rescored, k, docIdOf)
    }
    const rest = endOfRescored(candidates, depth, filter)
    return bestResolvedHits(rescored.concat(estimatedHits(candidates, rest, metric, minSimilarity, filter)), k, docIdOf)
  })
}
