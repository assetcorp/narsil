import type { HNSWIndex } from '../hnsw'
import type { VectorIndexState } from './shared'

export function threadsSearchOnly(state: VectorIndexState, graph: HNSWIndex | null): void {
  for (const [held, shared] of state.sharedHandles) {
    if (held !== graph && shared.searchable) state.sharedHandles.set(held, { ...shared, searchable: false })
  }
}
