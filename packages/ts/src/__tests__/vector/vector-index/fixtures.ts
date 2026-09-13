import type { VectorMetric } from '../../../vector/brute-force'
import type { OrdinalFilter } from '../../../vector/ordinal-filter'
import type { OrdinalSearchResult } from '../../../vector/search-pool'
import type { GraphInsertOutcome, SharedVectorFieldHandles } from '../../../vector/shared-field/types'
import { openSharedVectorField, type SharedVectorFieldView } from '../../../vector/shared-field/view'

export const DIM = 4

export function vectorFromValues(...values: number[]): Float32Array {
  return new Float32Array(values)
}

export function seededVector(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * (i + 1) * 1.618) * Math.cos(seed * 0.7 + i)
  }
  return v
}

export function normalizedVector(dim: number, seed: number): Float32Array {
  const v = seededVector(dim, seed)
  let sumSq = 0
  for (let i = 0; i < dim; i++) sumSq += v[i] * v[i]
  const mag = Math.sqrt(sumSq)
  if (mag === 0) return v
  for (let i = 0; i < dim; i++) v[i] /= mag
  return v
}

export interface FakeVectorThreads {
  open(handle: string, handles: SharedVectorFieldHandles): boolean
  drop(handle: string): void
  insertOrdinals(handle: string, ordinals: Int32Array): GraphInsertOutcome | null
  searchOrdinals(
    handle: string,
    query: Float32Array,
    k: number,
    metric: VectorMetric,
    minSimilarity: number,
    efSearch: number | undefined,
    filter: OrdinalFilter | undefined,
  ): OrdinalSearchResult
  viewOf(handle: string): SharedVectorFieldView | undefined
}

export function createFakeVectorThreads(threadSlot: number): FakeVectorThreads {
  const views = new Map<string, SharedVectorFieldView>()

  return {
    open(handle, handles) {
      const held = views.get(handle)
      if (held === undefined) views.set(handle, openSharedVectorField(handles, threadSlot))
      else held.adopt(handles)
      return true
    },

    drop(handle) {
      views.delete(handle)
    },

    insertOrdinals(handle, ordinals) {
      const view = views.get(handle)
      if (view === undefined) return null
      for (const ordinal of ordinals) view.insertOrdinal(ordinal)
      return view.takeOutcome()
    },

    searchOrdinals(handle, query, k, metric, minSimilarity, efSearch, filter) {
      const view = views.get(handle)
      if (view === undefined) throw new Error(`No thread holds a vector field under handle ${handle}`)
      const hits = view.searchOrdinals(query, k, metric, minSimilarity, filter, efSearch)
      return {
        ordinals: Uint32Array.from(hits.map(hit => hit.ord)),
        scores: Float64Array.from(hits.map(hit => hit.score)),
      }
    },

    viewOf: handle => views.get(handle),
  }
}
