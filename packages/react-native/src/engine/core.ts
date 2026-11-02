import type {
  NativeCore,
  NativeGraphHandle,
  NativeGraphMemory,
  NativeStoreHandle,
  NativeStoreMemory,
} from '@delali/narsil'
import type {
  GraphMemory,
  MemoryView,
  NarsilAttachedGraph,
  NarsilAttachedStore,
  NarsilCore,
  StoreMemory,
} from '../specs/core.nitro'
import { withNativeCode } from './native-error'

const ABSENT_REGION: MemoryView = { buffer: new ArrayBuffer(0), byteOffset: 0, byteLength: 0 }

function viewOf(array: ArrayBufferView): MemoryView {
  return { buffer: array.buffer as ArrayBuffer, byteOffset: array.byteOffset, byteLength: array.byteLength }
}

function graphMemoryOf(memory: NativeGraphMemory): GraphMemory {
  return {
    graphHeader: viewOf(memory.graphHeader),
    nodeLevels: viewOf(memory.nodeLevels),
    level0: viewOf(memory.level0),
    upperBase: viewOf(memory.upperBase),
    upper: viewOf(memory.upper),
    locks: viewOf(memory.locks),
    tombstones: viewOf(memory.tombstones),
    incoming: viewOf(memory.incoming),
    nearestLinkDue: viewOf(memory.nearestLinkDue),
    heldLocks: viewOf(memory.heldLocks),
  }
}

function storeMemoryOf(memory: NativeStoreMemory): StoreMemory {
  return {
    storeHeader: viewOf(memory.storeHeader),
    dimension: memory.dimension,
    bits: memory.bits,
    recordsPerBlock: memory.recordsPerBlock,
    vectorsPerBlock: memory.vectorsPerBlock,
    vectorStrideBytes: memory.vectorStrideBytes,
    codePresent: viewOf(memory.codePresent),
    centroid: viewOf(memory.centroid),
    magnitudes: viewOf(memory.magnitudes),
    present: viewOf(memory.present),
    vectorFile: viewOf(memory.vectorFile),
    vectorOffset: viewOf(memory.vectorOffset),
    vectorFiles: memory.vectorFiles,
    codeBlocks: memory.codeBlocks.map(viewOf),
    vectorBlocks: memory.vectorBlocks.map(block => (block === null ? ABSENT_REGION : viewOf(block))),
  }
}

function graphOf(handle: NativeGraphHandle): NarsilAttachedGraph {
  return handle as NarsilAttachedGraph
}

function storeOf(handle: NativeStoreHandle): NarsilAttachedStore {
  return handle as NarsilAttachedStore
}

export function adaptCore(core: NarsilCore): NativeCore {
  return {
    abiVersion: () => core.abiVersion(),
    workspaceBytes: () => core.workspaceBytes(),
    attachGraph(memory) {
      try {
        return core.attachGraph(graphMemoryOf(memory))
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    attachStore(memory) {
      try {
        return core.attachStore(storeMemoryOf(memory))
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    detachStore: store => storeOf(store).detach(),
    search(graph, store, query, metric, candidateCount, threadSlot, ordinals, distances, accepted) {
      return core.search(
        graphOf(graph),
        storeOf(store),
        viewOf(query),
        metric,
        candidateCount,
        threadSlot,
        viewOf(ordinals),
        viewOf(distances),
        accepted === null ? ABSENT_REGION : viewOf(accepted),
        accepted !== null,
      )
    },
    score: (store, query, metric, ordinals, count, distances) =>
      core.score(storeOf(store), viewOf(query), metric, viewOf(ordinals), count, viewOf(distances)),
    place: (graph, store, metric, ordinal, topLayer, graphHeldAlone, threadSlot, wakes) =>
      core.place(graphOf(graph), storeOf(store), metric, ordinal, topLayer, graphHeldAlone, threadSlot, viewOf(wakes)),
    remove: (graph, ordinal, threadSlot, wakes) => core.remove(graphOf(graph), ordinal, threadSlot, viewOf(wakes)),
    compact: (graph, store, metric, threadSlot, wakes) =>
      core.compact(graphOf(graph), storeOf(store), metric, threadSlot, viewOf(wakes)),
    connectUnreached: (graph, store, metric, nearby, threadSlot, wakes) =>
      core.connectUnreached(graphOf(graph), storeOf(store), metric, viewOf(nearby), threadSlot, viewOf(wakes)),
    measure: (store, metric, ordinals, count, totals) =>
      core.measure(storeOf(store), metric, viewOf(ordinals), count, viewOf(totals)),
    quantise: (store, metric, ordinals, count) => core.quantise(storeOf(store), metric, viewOf(ordinals), count),
  }
}
