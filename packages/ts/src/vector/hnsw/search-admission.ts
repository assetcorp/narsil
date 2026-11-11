import type { VectorMetric } from '../brute-force'
import type { VectorStore } from '../vector-store'
import { withTransientAdmissionAsync, writerAdmissionAt } from '../vector-store/admission'
import { type GraphSearchOptions, type ResolvedHit, search } from './search'
import { searchOffThread } from './search-off-thread'
import type { HNSWSearchState } from './shared'

export function searchAtWriterSequence(
  state: HNSWSearchState,
  store: VectorStore,
  docIdOf: (ordinal: number) => string | undefined,
  query: Float32Array,
  k: number,
  metric: VectorMetric,
  minSimilarity: number,
  options: GraphSearchOptions,
): ResolvedHit[] {
  if (options.admission !== undefined) return search(state, docIdOf, query, k, metric, minSimilarity, options)
  const admission = writerAdmissionAt(
    store.view,
    store.retiredStampHalves(),
    store.claimedSlots(),
    store.writeSequence(),
  )
  return search(state, docIdOf, query, k, metric, minSimilarity, { ...options, admission })
}

export function searchOffThreadUnderPin(
  state: HNSWSearchState,
  store: VectorStore,
  docIdOf: (ordinal: number) => string | undefined,
  query: Float32Array,
  k: number,
  metric: VectorMetric,
  minSimilarity: number,
  options: GraphSearchOptions,
): Promise<ResolvedHit[] | null> {
  if (options.admission !== undefined) {
    return searchOffThread(state, docIdOf, query, k, metric, minSimilarity, options)
  }
  return withTransientAdmissionAsync(store.view, admission =>
    searchOffThread(state, docIdOf, query, k, metric, minSimilarity, { ...options, admission }),
  )
}
