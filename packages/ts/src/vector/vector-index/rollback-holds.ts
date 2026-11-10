import { storePinsOf } from '#platform/vector-host'
import type { SharedVectorStoreView } from '../vector-store/view'
import type { VectorIndexState } from './shared'

interface HeldPin {
  view: SharedVectorStoreView
  pin: number
}

export interface RollbackHold {
  writes: number
  readonly ordinals: number[]
  readonly pins: HeldPin[]
}

function releaseHold(state: VectorIndexState, docId: string, hold: RollbackHold): void {
  hold.writes -= 1
  if (hold.writes > 0) return
  if (state.rollbackHolds.get(docId) === hold) state.rollbackHolds.delete(docId)
  for (const { view, pin } of hold.pins) storePinsOf(view).release(pin)
  hold.pins.length = 0
  hold.ordinals.length = 0
  state.cold?.replacements.delete(docId)
}

export function holdForRollback(state: VectorIndexState, docId: string): () => void {
  let hold = state.rollbackHolds.get(docId)
  if (hold === undefined) {
    hold = { writes: 0, ordinals: [], pins: [] }
    state.rollbackHolds.set(docId, hold)
  }
  hold.writes += 1
  const held = hold
  let released = false
  return () => {
    if (released) return
    released = true
    releaseHold(state, docId, held)
  }
}

export function keepRetiredOrdinal(state: VectorIndexState, docId: string, ordinal: number): void {
  const hold = state.rollbackHolds.get(docId)
  if (hold === undefined || hold.ordinals[hold.ordinals.length - 1] === ordinal) return
  const view = state.store.view
  hold.pins.push({ view, pin: storePinsOf(view).take() })
  hold.ordinals.push(ordinal)
}

export function forgetKeptOrdinal(state: VectorIndexState, docId: string, ordinal: number): void {
  const ordinals = state.rollbackHolds.get(docId)?.ordinals
  const at = ordinals?.lastIndexOf(ordinal) ?? -1
  if (ordinals !== undefined && at !== -1) ordinals.splice(at, 1)
}

export function keptOrdinalsOf(state: VectorIndexState, docId: string): readonly number[] {
  return state.rollbackHolds.get(docId)?.ordinals ?? []
}
