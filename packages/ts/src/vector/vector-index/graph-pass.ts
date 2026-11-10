import { turnsAreBudgeted } from '#platform/vector-host'
import type { HNSWIndex } from '../hnsw'
import type { GraphsHeldOffThread, VectorIndexState } from './shared'

function holdGraph(state: VectorIndexState, graph: HNSWIndex): GraphsHeldOffThread {
  const current = state.graphsHeldOffThread
  if (current !== null) {
    current.graphs.push(graph)
    return current
  }
  let release: () => void = () => undefined
  const released = new Promise<void>(resolve => {
    release = resolve
  })
  const held: GraphsHeldOffThread = { graphs: [graph], released, release, writesAfter: [] }
  state.graphsHeldOffThread = held
  return held
}

function applyWritesHeldBack(held: GraphsHeldOffThread): void {
  const writes = held.writesAfter.splice(0)
  let firstError: unknown = null
  for (const write of writes) {
    try {
      write()
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError !== null) throw firstError
}

function releaseGraph(state: VectorIndexState, held: GraphsHeldOffThread, graph: HNSWIndex): void {
  const at = held.graphs.indexOf(graph)
  if (at !== -1) held.graphs.splice(at, 1)
  if (held.graphs.length > 0) return
  if (state.graphsHeldOffThread === held) state.graphsHeldOffThread = null
  try {
    applyWritesHeldBack(held)
  } finally {
    held.release()
  }
}

export async function connectGraph(state: VectorIndexState, graph: HNSWIndex): Promise<void> {
  const offThread = graph.connectOffThread()
  if (offThread === null) {
    await graph.connectOnThisThread(turnsAreBudgeted)
    return
  }
  const held = holdGraph(state, graph)
  let connected = false
  try {
    connected = await offThread
  } finally {
    releaseGraph(state, held, graph)
  }
  if (!connected && !state.disposed) await graph.connectOnThisThread(true)
}

export async function untilGraphReleased(state: VectorIndexState): Promise<void> {
  for (;;) {
    const held = state.graphsHeldOffThread
    if (held === null) return
    await held.released
  }
}

export function waitOutGraphPass(state: VectorIndexState): void {
  const held = state.graphsHeldOffThread
  if (held === null) return
  for (const graph of held.graphs) graph.exclusively(() => undefined)
  applyWritesHeldBack(held)
}

export function withGraphFree<A extends unknown[], R>(
  state: VectorIndexState,
  operation: (...args: A) => R,
): (...args: A) => R {
  return (...args) => {
    waitOutGraphPass(state)
    return operation(...args)
  }
}

export function onceGraphFree<A extends unknown[], R>(
  state: VectorIndexState,
  operation: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args) => {
    await untilGraphReleased(state)
    return operation(...args)
  }
}

export function afterGraphPass(state: VectorIndexState, write: () => void): void {
  const held = state.graphsHeldOffThread
  if (held === null) write()
  else held.writesAfter.push(write)
}
