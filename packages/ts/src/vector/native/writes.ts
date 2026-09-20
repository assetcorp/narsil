import type { VectorMetric } from '../brute-force'
import type { HNSWSearchState } from '../hnsw/shared'
import { stopUsingTheNativeSearchCore } from './backend'
import { type NativeField, wakeSleepingThreads } from './field'
import { nativeMetricCode } from './store'
import { NATIVE_NEEDS_ROOM, NATIVE_OK } from './types'

export type NativePlacement = 'placed' | 'needsRoom' | 'failed'

const CALL_RAISED = -1

function writeToTheGraph(state: HNSWSearchState, field: NativeField, write: () => number): number {
  let status: number
  try {
    status = write()
  } catch (error) {
    stopUsingTheNativeSearchCore(error)
    return CALL_RAISED
  }
  wakeSleepingThreads(state, field)
  return status
}

export function nativePlace(
  state: HNSWSearchState,
  field: NativeField,
  metric: VectorMetric,
  ordinal: number,
  topLayer: number,
  graphHeldAlone: boolean,
): NativePlacement {
  const status = writeToTheGraph(state, field, () =>
    field.core.place(
      field.graph,
      field.store.handle,
      nativeMetricCode(metric),
      ordinal,
      topLayer,
      graphHeldAlone ? 1 : 0,
      state.locks.threadSlot,
      field.wakes,
    ),
  )
  if (status === NATIVE_OK) return 'placed'
  return status === NATIVE_NEEDS_ROOM ? 'needsRoom' : 'failed'
}

export function nativeRemove(state: HNSWSearchState, field: NativeField, ordinal: number): boolean {
  const remove = () => field.core.remove(field.graph, ordinal, state.locks.threadSlot, field.wakes)
  return writeToTheGraph(state, field, remove) === NATIVE_OK
}

export function nativeCompact(state: HNSWSearchState, field: NativeField, metric: VectorMetric): boolean {
  const compact = () =>
    field.core.compact(field.graph, field.store.handle, nativeMetricCode(metric), state.locks.threadSlot, field.wakes)
  return writeToTheGraph(state, field, compact) === NATIVE_OK
}
