import { adjacencySlots, incomingCount, layerBase, noteLinked, noteUnlinked } from './adjacency'
import { ABSENT, reachNode } from './adjacency/views'
import { NEAREST_LINK_FALLBACK_HOSTS } from './constants'
import { isLive } from './last-links'
import { type HNSWGraphState, nodeDistanceFunction } from './shared'

interface ScoredNode {
  ord: number
  distance: number
}

interface NearestLinkPass {
  state: HNSWGraphState
  distance: (aOrd: number, bOrd: number) => number
  nearest: Int32Array
}

const NOT_YET_FOUND = -2

function nearer(a: ScoredNode, b: ScoredNode): boolean {
  return a.distance < b.distance || (a.distance === b.distance && a.ord < b.ord)
}

function listOf(state: HNSWGraphState, ord: number): Int32Array | null {
  const adjacency = state.adjacency
  const base = layerBase(adjacency, ord, 0)
  if (base === ABSENT) return null
  return adjacency.level0.subarray(base + 1, base + 1 + adjacency.level0[base])
}

function nearestInList(pass: NearestLinkPass, ord: number): number {
  const known = pass.nearest[ord]
  if (known !== NOT_YET_FOUND) return known
  let best: ScoredNode | null = null
  for (const neighbour of listOf(pass.state, ord) ?? []) {
    if (neighbour === ord || !isLive(pass.state, neighbour)) continue
    const scored = { ord: neighbour, distance: pass.distance(ord, neighbour) }
    if (best === null || nearer(scored, best)) best = scored
  }
  const nearest = best === null ? -1 : best.ord
  pass.nearest[ord] = nearest
  return nearest
}

function fallbackHostsFor(pass: NearestLinkPass, ord: number, nearest: number): number[] {
  const around: ScoredNode[] = []
  for (const neighbour of listOf(pass.state, nearest) ?? []) {
    if (neighbour === ord || !isLive(pass.state, neighbour)) continue
    around.push({ ord: neighbour, distance: pass.distance(ord, neighbour) })
  }
  around.sort((a, b) => (nearer(a, b) ? -1 : nearer(b, a) ? 1 : 0))
  return around.slice(0, NEAREST_LINK_FALLBACK_HOSTS).map(scored => scored.ord)
}

function replaceableSlot(pass: NearestLinkPass, host: number, list: Int32Array): number {
  let farthest = -1
  let farthestNode: ScoredNode | null = null
  for (let i = 0; i < list.length; i++) {
    const neighbour = list[i]
    if (incomingCount(pass.state.adjacency, neighbour) < 2) continue
    if (isLive(pass.state, neighbour) && nearestInList(pass, neighbour) === host) continue
    const scored = { ord: neighbour, distance: pass.distance(host, neighbour) }
    if (farthestNode === null || nearer(farthestNode, scored)) {
      farthest = i
      farthestNode = scored
    }
  }
  return farthest
}

function linkFrom(pass: NearestLinkPass, host: number, ord: number): boolean {
  const adjacency = pass.state.adjacency
  const base = layerBase(adjacency, host, 0)
  if (base === ABSENT) return false
  const list = adjacency.level0.subarray(base + 1, base + 1 + adjacency.level0[base])
  if (list.includes(ord)) return true
  if (list.length < pass.state.Mmax0) {
    adjacency.level0[base + list.length + 1] = ord
    adjacency.level0[base] = list.length + 1
    noteLinked(adjacency, ord)
    pass.nearest[host] = NOT_YET_FOUND
    return true
  }
  const slot = replaceableSlot(pass, host, list)
  if (slot === -1) return false
  const replaced = list[slot]
  list[slot] = ord
  noteUnlinked(adjacency, replaced)
  noteLinked(adjacency, ord)
  pass.nearest[host] = NOT_YET_FOUND
  return true
}

export function linkFromNearest(state: HNSWGraphState): void {
  const adjacency = state.adjacency
  const slots = adjacencySlots(adjacency)
  if (slots > 0) reachNode(adjacency, slots - 1)
  const pass: NearestLinkPass = {
    state,
    distance: nodeDistanceFunction(state, state.buildMetric),
    nearest: new Int32Array(slots).fill(NOT_YET_FOUND),
  }
  for (let ord = 0; ord < slots; ord++) {
    if (Atomics.load(adjacency.nearestLinkDue, ord) !== 1) continue
    Atomics.store(adjacency.nearestLinkDue, ord, 0)
    if (!isLive(state, ord)) continue
    const nearest = nearestInList(pass, ord)
    if (nearest === -1 || linkFrom(pass, nearest, ord)) continue
    for (const host of fallbackHostsFor(pass, ord, nearest)) if (linkFrom(pass, host, ord)) break
  }
}
