import type { VectorMetric } from '../brute-force'
import { GRAPH_LOCK } from '../hnsw/handles'
import type { HNSWSearchState } from '../hnsw/shared'
import { stopUsingTheNativeSearchCore } from './backend'
import { type NativeField, wakeListedThreads, wakeSleepingThreads } from './field'
import { nativeMetricCode } from './store'
import { claimNativeThreadSlotNow, returnSlot } from './thread-slots'
import {
  NATIVE_GRAPH_NOT_HELD_ALONE,
  NATIVE_NEEDS_ROOM,
  NATIVE_OK,
  type NativeConnectResult,
  type NativeCore,
} from './types'

export type NativePlacement = 'placed' | 'needsRoom' | 'failed'

const CALL_RAISED = -1
const NO_NEARBY_NODES = new Int32Array(0)

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

export function nativeConnect(
  state: HNSWSearchState,
  field: NativeField,
  metric: VectorMetric,
  nearby: Int32Array,
): boolean {
  const connect = () =>
    field.core.connectUnreached(
      field.graph,
      field.store.handle,
      nativeMetricCode(metric),
      nearby,
      state.locks.threadSlot,
      field.wakes,
    )
  return writeToTheGraph(state, field, connect) === NATIVE_OK
}

type OffThreadConnecting = NativeCore & Required<Pick<NativeCore, 'connectUnreachedAsync'>>

function connectsOffThread(core: NativeCore): core is OffThreadConnecting {
  return core.connectUnreachedAsync !== undefined
}

export function nativeConnectsOffThread(field: NativeField): boolean {
  return connectsOffThread(field.core)
}

export type OffThreadConnect = 'connected' | 'graphBusy' | 'failed'

export async function nativeConnectOffThread(
  state: HNSWSearchState,
  field: NativeField,
  metric: VectorMetric,
): Promise<OffThreadConnect> {
  const core = field.core
  if (!connectsOffThread(core)) return 'failed'
  const slot = claimNativeThreadSlotNow()
  if (slot === null) return 'graphBusy'
  let outcome: NativeConnectResult
  try {
    outcome = await core.connectUnreachedAsync(
      field.graph,
      field.store.handle,
      nativeMetricCode(metric),
      NO_NEARBY_NODES,
      slot,
    )
  } catch {
    return 'failed'
  } finally {
    returnSlot(slot)
  }
  wakeListedThreads(state, outcome.wakes)
  Atomics.notify(state.header, GRAPH_LOCK)
  if (outcome.status === NATIVE_OK) return 'connected'
  return outcome.status === NATIVE_GRAPH_NOT_HELD_ALONE ? 'graphBusy' : 'failed'
}
