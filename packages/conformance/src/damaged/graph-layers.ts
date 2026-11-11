import { bytesAt, packedUint32s, type RawMap, uint32s } from './bytes'

const UPPER_LISTS_PER_NODE_FACTOR = 4
const UPPER_LISTS_ALLOWANCE = 64
const HIGHEST_TOP_LAYER = 32

export function upperListLimit(nodes: number, m: number): number {
  return Math.floor((UPPER_LISTS_PER_NODE_FACTOR * nodes + UPPER_LISTS_ALLOWANCE * (m - 1)) / (m - 1))
}

function withTopLayers(graph: RawMap, tops: readonly number[]): void {
  const levels = bytesAt(graph.levels, 'levels')
  const values = uint32s(bytesAt(graph.neighbours, 'neighbours'))
  const raised: number[] = []
  let cursor = 0
  for (let at = 0; at < levels.length; at++) {
    const level = levels[at] ?? 0
    for (let list = 0; list < level; list++) {
      const count = values[cursor] ?? 0
      raised.push(...values.slice(cursor, cursor + count + 1))
      cursor += count + 1
    }
    const top = tops[at] ?? -1
    for (let list = level; list <= top; list++) raised.push(0)
  }
  graph.levels = new Uint8Array(tops.map(top => top + 1))
  graph.neighbours = packedUint32s(raised)
}

function topLayersOf(graph: RawMap): number[] {
  return Array.from(bytesAt(graph.levels, 'levels'), level => level - 1)
}

export function nodesOf(graph: RawMap): number {
  return topLayersOf(graph).filter(top => top >= 0).length
}

export function withEveryNodeOnTheHighestLayer(graph: RawMap): void {
  withTopLayers(
    graph,
    topLayersOf(graph).map(top => (top < 0 ? top : HIGHEST_TOP_LAYER)),
  )
  graph.maxLayer = HIGHEST_TOP_LAYER
}

export function withUpperLists(graph: RawMap, wanted: number): void {
  const tops = topLayersOf(graph)
  const entry = Number(graph.entryPoint)
  const order = [entry, ...tops.map((_, at) => at).filter(at => at !== entry)]
  let held = tops.reduce((sum, top) => sum + Math.max(top, 0), 0)
  for (const at of order) {
    if (held >= wanted) break
    const top = tops[at] ?? -1
    if (top < 0) continue
    const raise = Math.min(HIGHEST_TOP_LAYER - top, wanted - held)
    tops[at] = top + raise
    held += raise
  }
  if (held !== wanted) throw new Error(`the graph holds room for ${held} upper-layer lists, not ${wanted}`)
  if ((tops[entry] ?? -1) !== HIGHEST_TOP_LAYER) throw new Error('the entry point sits below the highest layer')
  withTopLayers(graph, tops)
  graph.maxLayer = HIGHEST_TOP_LAYER
}
