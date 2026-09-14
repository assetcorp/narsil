import type { QuantizerBuildReader } from '../osq/types'
import { fixedView } from '../shared-buffers/growable'
import type { VectorBuildReader } from '../vector-store'
import { openAdjacency } from './adjacency'
import { graphShapeOf, type SharedGraphHandles } from './handles'
import { openGraphLocks } from './locks'
import type { HNSWGraphState } from './shared'
import { createHNSWWorkspace } from './workspace'

export function openGraphState(
  handles: SharedGraphHandles,
  dimension: number,
  store: VectorBuildReader,
  quantizer: QuantizerBuildReader | undefined,
  threadSlot: number,
): HNSWGraphState {
  const shape = graphShapeOf(handles.header)
  const adjacency = openAdjacency(handles, shape.m, shape.mMax0)
  return {
    dimension,
    store,
    quantizer,
    adjacency,
    locks: openGraphLocks(handles, threadSlot),
    header: handles.header,
    tombstones: fixedView(handles.tombstones, Uint8Array),
    visited: new Uint32Array(0),
    visitStamp: 0,
    workspace: createHNSWWorkspace(),
    neighborScratch: new Int32Array(adjacency.level0Stride),
    M: shape.m,
    Mmax0: shape.mMax0,
    efCons: shape.efConstruction,
    buildMetric: shape.metric,
    mL: 1 / Math.log(shape.m),
  }
}
