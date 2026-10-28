import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorMetric } from '../brute-force'
import { adjacencySlots, createNode, layerArray, layerBase, writeNeighbors } from './adjacency'
import { leaveIncomingUncounted } from './connect-unreached'
import { MAX_LAYER_CAP } from './constants'
import { GRAPH_ENTRY_POINT, GRAPH_NODE_COUNT, GRAPH_TOP_LAYER } from './handles'
import { resetGraph } from './mutation'
import { ensureCapacity, entryPointOf, type HNSWGraphState, maxConns, nodeMaxLayer, topLayerOf } from './shared'

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
  if (ordinal === NO_ORDINAL) return NO_LAYER
  return Math.min(nodeMaxLayer(state, ordinal), MAX_LAYER_CAP)
}

export interface NumberedGraphParts {
  partSize: number
  parts: readonly NumberedHnswGraph[]
}

function neighbourValueCount(state: HNSWGraphState, topLayers: Int8Array, start: number, end: number): number {
  let values = 0
  for (let number = start; number < end; number++) {
    const top = topLayers[number]
    if (top < 0) continue
    values += state.adjacency.level0Stride + top * state.adjacency.upperStride
  }
  return values
}

function serializePart(
  state: HNSWGraphState,
  numbers: { numberOfOrdinal: Int32Array; ordinalOfNumber: Int32Array; topLayers: Int8Array },
  start: number,
  end: number,
): { levels: Uint8Array; neighbours: Uint8Array } {
  const { numberOfOrdinal, ordinalOfNumber, topLayers } = numbers
  const adjacency = state.adjacency
  const levels = new Uint8Array(end - start)
  const values = new Uint32Array(neighbourValueCount(state, topLayers, start, end))
  let cursor = 0
  for (let number = start; number < end; number++) {
    const top = topLayers[number]
    levels[number - start] = top + 1
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
  return { levels, neighbours: littleEndianBytesOf(values.subarray(0, cursor)) }
}

export function serializeNumberedGraphParts(
  state: HNSWGraphState,
  numberOfOrdinal: Int32Array,
  ordinalOfNumber: Int32Array,
  partSize: number,
): NumberedHnswGraph[] {
  const slots = adjacencySlots(state.adjacency)
  const topLayers = new Int8Array(ordinalOfNumber.length).fill(-1)
  for (let number = 0; number < ordinalOfNumber.length; number++) {
    const ordinal = ordinalOfNumber[number]
    if (ordinal >= slots) continue
    topLayers[number] = savedTopLayer(state, ordinal)
  }
  const entryOrdinal = entryPointOf(state)
  const entryNumber =
    entryOrdinal >= 0 && entryOrdinal < numberOfOrdinal.length ? numberOfOrdinal[entryOrdinal] : NO_NUMBER
  const entryHoldsNode = entryNumber !== NO_NUMBER && topLayers[entryNumber] >= 0
  const header = {
    entryPoint: entryHoldsNode ? entryNumber : null,
    maxLayer: Math.max(0, Math.min(topLayerOf(state), MAX_LAYER_CAP)),
    m: state.M,
    efConstruction: state.efCons,
    metric: state.buildMetric,
  }
  const numbers = { numberOfOrdinal, ordinalOfNumber, topLayers }
  const parts: NumberedHnswGraph[] = []
  for (let start = 0; start < ordinalOfNumber.length; start += partSize) {
    const end = Math.min(start + partSize, ordinalOfNumber.length)
    parts.push({ ...header, ...serializePart(state, numbers, start, end) })
  }
  return parts
}

export function graphWithoutNodes(
  part: NumberedHnswGraph,
  firstNumber: number,
  numbers: ReadonlySet<number>,
): NumberedHnswGraph {
  const values = valuesOf(part.neighbours)
  const levels = part.levels.slice()
  const kept = new Uint32Array(values.length)
  let cursor = 0
  let length = 0
  for (let at = 0; at < part.levels.length; at++) {
    const start = cursor
    for (let layer = 0; layer < part.levels[at]; layer++) cursor += values[cursor] + 1
    if (numbers.has(firstNumber + at)) {
      levels[at] = 0
      continue
    }
    kept.set(values.subarray(start, cursor), length)
    length += cursor - start
  }
  const entryPoint = part.entryPoint !== null && numbers.has(part.entryPoint) ? null : part.entryPoint
  return { ...part, entryPoint, levels, neighbours: littleEndianBytesOf(kept.subarray(0, length)) }
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

export function topLayerInParts(graph: NumberedGraphParts, number: number): number {
  const part = graph.parts[Math.floor(number / graph.partSize)]
  if (part === undefined) return -1
  const at = number % graph.partSize
  return at < part.levels.length ? part.levels[at] - 1 : -1
}

function highestNodeOrdinal(graph: NumberedGraphParts, ordinalAt: (number: number) => number): number {
  let highest = -1
  for (let p = 0; p < graph.parts.length; p++) {
    const levels = graph.parts[p].levels
    for (let at = 0; at < levels.length; at++) {
      const ordinal = ordinalAt(p * graph.partSize + at)
      if (levels[at] > 0 && ordinal > highest) highest = ordinal
    }
  }
  return highest
}

export function deserializeNumberedGraph(
  state: HNSWGraphState,
  graph: NumberedGraphParts,
  ordinalOfNumber: Int32Array,
): void {
  for (const part of graph.parts) requireWholeNeighbourLists(part)
  resetGraph(state)
  const ordinalAt = (number: number) => (number < ordinalOfNumber.length ? ordinalOfNumber[number] : NO_ORDINAL)
  const highestOrdinal = highestNodeOrdinal(graph, ordinalAt)
  if (highestOrdinal >= 0) ensureCapacity(state, highestOrdinal + 1)

  const kept: number[] = []
  let highestLayer = -1
  let nodeOnHighestLayer = NO_ORDINAL
  for (let p = 0; p < graph.parts.length; p++) {
    const part = graph.parts[p]
    const values = valuesOf(part.neighbours)
    let cursor = 0
    for (let at = 0; at < part.levels.length; at++) {
      const number = p * graph.partSize + at
      const top = part.levels[at] - 1
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
          if (neighbourOrdinal === NO_ORDINAL || neighbour === number) continue
          if (topLayerInParts(graph, neighbour) < layer) continue
          if (!kept.includes(neighbourOrdinal)) kept.push(neighbourOrdinal)
        }
        cursor += count + 1
        if (ordinal !== NO_ORDINAL && layer <= keptTop) {
          writeNeighbors(state.adjacency, ordinal, layer, kept, kept.length)
        }
      }
    }
  }

  const first = graph.parts[0]
  const entryPoint = first === undefined ? null : first.entryPoint
  const entryOrdinal = entryPoint === null ? NO_ORDINAL : ordinalAt(entryPoint)
  const entryTop = entryPoint === null ? -1 : Math.min(topLayerInParts(graph, entryPoint), MAX_LAYER_CAP)
  const entryIsUsable = entryOrdinal !== NO_ORDINAL && entryTop >= 0
  Atomics.store(state.header, GRAPH_ENTRY_POINT, entryIsUsable ? entryOrdinal : nodeOnHighestLayer)
  Atomics.store(state.header, GRAPH_TOP_LAYER, entryIsUsable ? entryTop : highestLayer)
  leaveIncomingUncounted(state)
}
