import { layerArray, layerBase } from './adjacency'
import { type HNSWGraphState, maxConns, nodeMaxLayer } from './shared'

const NO_NUMBER = -1

export interface SavedNumbering {
  numberOfOrdinal: Int32Array
  topLayers: Int8Array
}

export interface SavedNeighbourScratch {
  kept: number[]
  dropped: number[]
  reached: number[]
  seen: Set<number>
}

export function createSavedNeighbourScratch(): SavedNeighbourScratch {
  return { kept: [], dropped: [], reached: [], seen: new Set() }
}

function savedNumberAt(numbering: SavedNumbering, ordinal: number, layer: number): number {
  if (ordinal < 0 || ordinal >= numbering.numberOfOrdinal.length) return NO_NUMBER
  const number = numbering.numberOfOrdinal[ordinal]
  if (number === NO_NUMBER || numbering.topLayers[number] < layer) return NO_NUMBER
  return number
}

function eachNeighbour(
  state: HNSWGraphState,
  ordinal: number,
  layer: number,
  visit: (neighbour: number) => void,
): void {
  const base = layerBase(state.adjacency, ordinal, layer)
  if (base === -1) return
  const array = layerArray(state.adjacency, layer)
  const held = Math.min(array[base], maxConns(state, layer))
  for (let i = 1; i <= held; i++) visit(array[base + i])
}

function reachPastDropped(
  state: HNSWGraphState,
  numbering: SavedNumbering,
  ordinal: number,
  layer: number,
  scratch: SavedNeighbourScratch,
): void {
  const { kept, dropped, reached, seen } = scratch
  const limit = maxConns(state, layer)
  seen.clear()
  seen.add(ordinal)
  for (const neighbour of kept) seen.add(neighbour)
  for (const neighbour of dropped) seen.add(neighbour)
  for (let crossed = 0; crossed < dropped.length && crossed < limit; crossed++) {
    eachNeighbour(state, dropped[crossed], layer, neighbour => {
      if (neighbour < 0 || seen.has(neighbour)) return
      seen.add(neighbour)
      if (savedNumberAt(numbering, neighbour, layer) !== NO_NUMBER) reached.push(neighbour)
      else if (nodeMaxLayer(state, neighbour) >= layer) dropped.push(neighbour)
    })
  }
}

function keepNearest(ordinal: number, reached: number[], room: number, distance: (a: number, b: number) => number) {
  if (reached.length <= room) return
  const scored = reached.map(neighbour => ({ neighbour, distance: distance(ordinal, neighbour) }))
  scored.sort((a, b) => a.distance - b.distance)
  reached.length = room
  for (let i = 0; i < room; i++) reached[i] = scored[i].neighbour
}

export function savedNeighbourNumbers(
  state: HNSWGraphState,
  numbering: SavedNumbering,
  ordinal: number,
  layer: number,
  distance: (aOrd: number, bOrd: number) => number,
  scratch: SavedNeighbourScratch,
  out: number[],
): void {
  const { kept, dropped, reached } = scratch
  out.length = 0
  kept.length = 0
  dropped.length = 0
  reached.length = 0
  eachNeighbour(state, ordinal, layer, neighbour => {
    if (neighbour === ordinal) return
    if (savedNumberAt(numbering, neighbour, layer) !== NO_NUMBER) kept.push(neighbour)
    else if (nodeMaxLayer(state, neighbour) >= layer) dropped.push(neighbour)
  })
  const room = maxConns(state, layer) - kept.length
  if (dropped.length > 0 && room > 0) {
    reachPastDropped(state, numbering, ordinal, layer, scratch)
    keepNearest(ordinal, reached, room, distance)
  }
  for (const neighbour of kept) out.push(savedNumberAt(numbering, neighbour, layer))
  for (const neighbour of reached) out.push(savedNumberAt(numbering, neighbour, layer))
}
