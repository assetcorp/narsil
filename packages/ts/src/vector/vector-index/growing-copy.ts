import { chargeHeapBytes } from '../../runtime/thread-heap'
import type { HNSWIndex } from '../hnsw'
import { insertIntoGraph } from './build-host'
import { moveOutOfBuffer } from './search-writes'
import type { VectorIndexState } from './shared'
import { dropSharedGraph, noteWrite, shareGraph } from './worker-copies'

const lineages = new WeakMap<HNSWIndex, object>()

function lineageOfGraph(graph: HNSWIndex): object {
  const known = lineages.get(graph)
  if (known !== undefined) return known
  const lineage = {}
  lineages.set(graph, lineage)
  return lineage
}

export function lineageOf(graph: HNSWIndex | null): object | null {
  return graph === null ? null : lineageOfGraph(graph)
}

function moveWhatTheCopyHoldsOutOfBuffer(state: VectorIndexState, copy: HNSWIndex): void {
  for (const docId of [...state.buffer]) {
    const ordinal = state.store.getOrdinal(docId)
    if (ordinal !== undefined && copy.holdsNode(ordinal) && !copy.holdsTombstone(ordinal)) moveOutOfBuffer(state, docId)
  }
}

async function publishCopy(state: VectorIndexState, graph: HNSWIndex, copy: HNSWIndex): Promise<boolean> {
  if (state.sharedHandles.get(graph)?.searchable === true) await shareGraph(state, copy, true)
  if (state.disposed || state.hnsw !== graph) return false
  lineages.set(copy, lineageOfGraph(graph))
  state.hnsw = copy
  graph.retire()
  moveWhatTheCopyHoldsOutOfBuffer(state, copy)
  dropSharedGraph(state, graph)
  noteWrite(state)
  return true
}

function* startingWith(first: string, rest: Iterator<string>): Generator<string> {
  yield first
  for (let next = rest.next(); !next.done; next = rest.next()) yield next.value
}

export async function placeInGrowingCopy(
  state: VectorIndexState,
  graph: HNSWIndex,
  docIds: Iterable<string>,
  admit: (docId: string) => boolean,
): Promise<boolean> {
  const pending = docIds[Symbol.iterator]()
  let first = pending.next()
  while (!first.done && !admit(first.value)) first = pending.next()
  if (first.done) return true
  const copy = graph.copy()
  const chargedBytes = copy.graphBytes
  chargeHeapBytes(chargedBytes)
  state.growingCopy = copy
  let published = false
  try {
    const placed = await insertIntoGraph(state, copy, startingWith(first.value, pending), admit)
    published = placed && !state.disposed && state.hnsw === graph && (await publishCopy(state, graph, copy))
    return published
  } finally {
    if (state.growingCopy === copy) state.growingCopy = null
    chargeHeapBytes(-chargedBytes)
    if (!published) {
      copy.retire()
      dropSharedGraph(state, copy)
    }
  }
}
