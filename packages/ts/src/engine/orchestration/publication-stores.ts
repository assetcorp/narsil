import type { CopyPublication } from '../../workers/copy-publication'
import type { OrchestratorState } from './types'

export function trackPublicationStores(state: OrchestratorState, publication: CopyPublication): void {
  for (const { vector } of publication.fields) {
    state.sharedVectorFields.set(vector.handle, vector.handles)
    state.publishedVectorStores.add(vector.handle)
  }
}

export function prunePublicationStores(state: OrchestratorState): void {
  for (const handle of state.publishedVectorStores) {
    const field = state.sharedVectorFields.get(handle)
    if (field !== undefined) {
      let pinned = false
      for (let slot = 0; slot < field.store.pins.length; slot++) {
        if (Atomics.load(field.store.pins, slot) !== 0n) {
          pinned = true
          break
        }
      }
      if (pinned) continue
    }
    state.sharedVectorFields.delete(handle)
    state.publishedVectorStores.delete(handle)
  }
}
