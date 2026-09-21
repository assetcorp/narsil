import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorMetric } from '../brute-force'
import { adjacencySlots, createNode, layerArray, layerBase, replaceNeighbors } from './adjacency'
import { MAX_LAYER_CAP } from './constants'
import { GRAPH_ENTRY_POINT, GRAPH_NODE_COUNT, GRAPH_TOP_LAYER } from './handles'
import { resetGraph } from './mutation'
import {
  ensureCapacity,
  entryPointOf,
  type HNSWGraphState,
  isTombstoned,
  maxConns,
  nodeMaxLayer,
  topLayerOf,
} from './shared'

const NO_NUMBER = -1
const NO_ORDINAL = -1
const NO_LAYER = -1
const BYTES_PER_VALUE = 4
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

export interface NumberedHnswGraph {
  entryPoint: number | null
  maxLayer: number
  m: number
  efConstruction: number
  metric: VectorMetric
  levels: Uint8Array
  neighbours: Uint8Array
}

function swapEveryValue(bytes: Uint8Array): void {
  for (let i = 0; i + 3 < bytes.length; i += BYTES_PER_VALUE) {
    const first = bytes[i]
    const second = bytes[i + 1]
    bytes[i] = bytes[i + 3]
    bytes[i + 1] = bytes[i + 2]
    bytes[i + 2] = second
    bytes[i + 3] = first
  }
}

function littleEndianBytesOf(values: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength)
  if (!LITTLE_ENDIAN) swapEveryValue(bytes)
  return bytes
}

function valuesOf(bytes: Uint8Array): Uint32Array {
  if (LITTLE_ENDIAN && bytes.byteOffset % BYTES_PER_VALUE === 0) {
    return new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / BYTES_PER_VALUE))
  }
  const copy = bytes.slice(0, bytes.byteLength - (bytes.byteLength % BYTES_PER_VALUE))
  if (!LITTLE_ENDIAN) swapEveryValue(copy)
  return new Uint32Array(copy.buffer, 0, copy.byteLength / BYTES_PER_VALUE)
}

function savedTopLayer(state: HNSWGraphState, ordinal: number): number {
  if (ordinal === NO_ORDINAL || isTombstoned(state, ordinal)) return NO_LAYER
  return Math.min(nodeMaxLayer(state, ordinal), MAX_LAYER_CAP)
}

function largestNeighbourValueCount(state: HNSWGraphState, topLayers: Int8Array): number {
  let values = 0
  for (let number = 0; number < topLayers.length; number++) {
    const top = topLayers[number]
    if (top < 0) continue
    values += state.adjacency.level0Stride + top * state.adjacency.upperStride
  }
  return values
}

export function serializeNumberedGraph(
  state: HNSWGraphState,
  numberOfOrdinal: Int32Array,
  ordinalOfNumber: Int32Array,
): NumberedHnswGraph {
  const adjacency = state.adjacency
  const slots = adjacencySlots(adjacency)
  const topLayers = new Int8Array(ordinalOfNumber.length).fill(-1)
  const levels = new Uint8Array(ordinalOfNumber.length)
  for (let number = 0; number < ordinalOfNumber.length; number++) {
    const ordinal = ordinalOfNumber[number]
    if (ordinal >= slots) continue
    topLayers[number] = savedTopLayer(state, ordinal)
    levels[number] = topLayers[number] + 1
  }

  const values = new Uint32Array(largestNeighbourValueCount(state, topLayers))
  let cursor = 0
  for (let number = 0; number < ordinalOfNumber.length; number++) {
    const top = topLayers[number]
    for (let layer = 0; layer <= top; layer++) {
      const base = layerBase(adjacency, ordinalOfNumber[number], layer)
      const array = layerArray(adjacency, layer)
      const held = base === -1 ? 0 : Math.min(array[base], maxConns(state, layer))
      const countAt = cursor
      cursor += 1
      for (let i = 1; i <= held; i++) {
        const neighbourOrdinal = array[base + i]
        if (neighbourOrdinal < 0 || neighbourOrdinal >= numberOfOrdinal.length) continue
        const neighbour = numberOfOrdinal[neighbourOrdinal]
        if (neighbour === NO_NUMBER || neighbour === number || topLayers[neighbour] < layer) continue
        values[cursor] = neighbour
        cursor += 1
      }
      values[countAt] = cursor - countAt - 1
    }
  }

  const entryOrdinal = entryPointOf(state)
  const entryNumber =
    entryOrdinal >= 0 && entryOrdinal < numberOfOrdinal.length ? numberOfOrdinal[entryOrdinal] : NO_NUMBER
  const entryHoldsNode = entryNumber !== NO_NUMBER && topLayers[entryNumber] >= 0
  return {
    entryPoint: entryHoldsNode ? entryNumber : null,
    maxLayer: Math.max(0, Math.min(topLayerOf(state), MAX_LAYER_CAP)),
    m: state.M,
    efConstruction: state.efCons,
    metric: state.buildMetric,
    levels,
    neighbours: littleEndianBytesOf(values.subarray(0, cursor)),
  }
}

function endsInsideAList(): never {
  throw new NarsilError(
    ErrorCodes.PERSISTENCE_LOAD_FAILED,
    'Invalid vector graph payload: neighbours ends inside a list',
  )
}

export function requireWholeNeighbourLists(graph: NumberedHnswGraph): void {
  const values = valuesOf(graph.neighbours)
  if (values.length * BYTES_PER_VALUE !== graph.neighbours.byteLength) endsInsideAList()
  let cursor = 0
  for (let number = 0; number < graph.levels.length; number++) {
    for (let layer = 0; layer < graph.levels[number]; layer++) {
      if (cursor >= values.length) endsInsideAList()
      const count = values[cursor]
      if (count > values.length - cursor - 1) endsInsideAList()
      cursor += count + 1
    }
  }
}

function topLayerIn(graph: NumberedHnswGraph, number: number): number {
  return number < graph.levels.length ? graph.levels[number] - 1 : -1
}

export function deserializeNumberedGraph(
  state: HNSWGraphState,
  graph: NumberedHnswGraph,
  ordinalOfNumber: Int32Array,
): void {
  requireWholeNeighbourLists(graph)
  resetGraph(state)
  const values = valuesOf(graph.neighbours)
  const ordinalAt = (number: number) => (number < ordinalOfNumber.length ? ordinalOfNumber[number] : NO_ORDINAL)

  let highestOrdinal = -1
  for (let number = 0; number < graph.levels.length; number++) {
    if (graph.levels[number] > 0 && ordinalAt(number) > highestOrdinal) highestOrdinal = ordinalAt(number)
  }
  if (highestOrdinal >= 0) ensureCapacity(state, highestOrdinal + 1)

  const kept: number[] = []
  let cursor = 0
  let highestLayer = -1
  let nodeOnHighestLayer = NO_ORDINAL
  for (let number = 0; number < graph.levels.length; number++) {
    const top = graph.levels[number] - 1
    if (top < 0) continue
    const ordinal = ordinalAt(number)
    const keptTop = Math.min(top, MAX_LAYER_CAP)
    if (ordinal !== NO_ORDINAL) {
      createNode(state.adjacency, ordinal, keptTop)
      Atomics.add(state.header, GRAPH_NODE_COUNT, 1)
      if (keptTop > highestLayer) {
        highestLayer = keptTop
        nodeOnHighestLayer = ordinal
      }
    }
    for (let layer = 0; layer <= top; layer++) {
      const count = values[cursor]
      kept.length = 0
      const limit = maxConns(state, layer)
      for (let i = 1; i <= count && kept.length < limit; i++) {
        const neighbour = values[cursor + i]
        const neighbourOrdinal = ordinalAt(neighbour)
        if (neighbourOrdinal === NO_ORDINAL || neighbour === number || topLayerIn(graph, neighbour) < layer) continue
        if (!kept.includes(neighbourOrdinal)) kept.push(neighbourOrdinal)
      }
      cursor += count + 1
      if (ordinal !== NO_ORDINAL && layer <= keptTop) {
        replaceNeighbors(state.adjacency, ordinal, layer, kept, kept.length)
      }
    }
  }

  const entryOrdinal = graph.entryPoint === null ? NO_ORDINAL : ordinalAt(graph.entryPoint)
  const entryTop = graph.entryPoint === null ? -1 : Math.min(topLayerIn(graph, graph.entryPoint), MAX_LAYER_CAP)
  const entryIsUsable = entryOrdinal !== NO_ORDINAL && entryTop >= 0
  Atomics.store(state.header, GRAPH_ENTRY_POINT, entryIsUsable ? entryOrdinal : nodeOnHighestLayer)
  Atomics.store(state.header, GRAPH_TOP_LAYER, entryIsUsable ? entryTop : highestLayer)
}
