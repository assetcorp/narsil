import { fixedView } from '../shared-buffers/growable'
import {
  adjacencySlots,
  ensureAdjacencyCapacity,
  ensureUpperCapacity,
  openAdjacency,
  rebindNodes,
  upperUsed,
} from './adjacency'
import {
  createSharedGraphHandles,
  GRAPH_ENTRY_POINT,
  GRAPH_INCOMING_UNCOUNTED,
  GRAPH_NODE_COUNT,
  GRAPH_SLOTS,
  GRAPH_TOMBSTONE_COUNT,
  GRAPH_TOP_LAYER,
  GRAPH_UNLINKED_NODES,
  GRAPH_UPPER_USED,
  graphShapeOf,
  type SharedGraphHandles,
} from './handles'
import type { HNSWGraphState } from './shared'

const COPIED_HEADER_WORDS = [
  GRAPH_ENTRY_POINT,
  GRAPH_TOP_LAYER,
  GRAPH_NODE_COUNT,
  GRAPH_TOMBSTONE_COUNT,
  GRAPH_UNLINKED_NODES,
  GRAPH_INCOMING_UNCOUNTED,
] as const

export function copyGraphHandles(state: HNSWGraphState): SharedGraphHandles {
  const source = state.adjacency
  rebindNodes(source)
  const handles = createSharedGraphHandles(graphShapeOf(source.header))
  const target = openAdjacency(handles, source.m, source.mMax0)
  const slots = adjacencySlots(source)
  const used = upperUsed(source)
  ensureAdjacencyCapacity(target, slots)
  ensureUpperCapacity(target, used)
  target.nodeLevels.set(source.nodeLevels.subarray(0, slots))
  target.level0.set(source.level0.subarray(0, slots * source.level0Stride))
  target.upperBase.set(source.upperBase.subarray(0, slots))
  target.upper.set(fixedView(source.handles.upper, Int32Array).subarray(0, used))
  target.incoming.set(source.incoming.subarray(0, slots))
  target.nearestLinkDue.set(source.nearestLinkDue.subarray(0, slots))
  fixedView(handles.tombstones, Uint8Array).set(fixedView(source.handles.tombstones, Uint8Array).subarray(0, slots))
  for (const word of COPIED_HEADER_WORDS) handles.header[word] = Atomics.load(source.header, word)
  Atomics.store(handles.header, GRAPH_UPPER_USED, used)
  Atomics.store(handles.header, GRAPH_SLOTS, slots)
  return handles
}
