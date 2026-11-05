import { adjacencySlots, incomingCount, layerBase, noteLinked, noteUnlinked } from './adjacency'
import { ABSENT, reachNode } from './adjacency/views'
import { drain, newPace, type Pace, type Steps, stepTaken } from './connect-steps'
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
  anchoredBy: Int32Array
}

const NOT_YET_FOUND = -2
const NOT_ANCHORED = -1

function nearer(a: ScoredNode, b: ScoredNode): boolean {
  return nearerPair(a.distance, a.ord, b.distance, b.ord)
}

function nearerPair(aDistance: number, aOrd: number, bDistance: number, bOrd: number): boolean {
  return aDistance < bDistance || (aDistance === bDistance && aOrd < bOrd)
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
  let nearest = -1
  let nearestDistance = Number.POSITIVE_INFINITY
  const level0 = pass.state.adjacency.level0
  const base = layerBase(pass.state.adjacency, ord, 0)
  const end = base === ABSENT ? base : base + 1 + level0[base]
  for (let at = base + 1; base !== ABSENT && at < end; at++) {
    const neighbour = level0[at]
    if (neighbour === ord || !isLive(pass.state, neighbour)) continue
    const distance = pass.distance(ord, neighbour)
    if (nearest === -1 || nearerPair(distance, neighbour, nearestDistance, nearest)) {
      nearest = neighbour
      nearestDistance = distance
    }
  }
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
  let farthestOrd = -1
  let farthestDistance = Number.NEGATIVE_INFINITY
  for (let i = 0; i < list.length; i++) {
    const neighbour = list[i]
    if (incomingCount(pass.state.adjacency, neighbour) < 2) continue
    if (
      isLive(pass.state, neighbour) &&
      (nearestInList(pass, neighbour) === host || pass.anchoredBy[neighbour] === host)
    )
      continue
    const distance = pass.distance(host, neighbour)
    if (farthest === -1 || nearerPair(farthestDistance, farthestOrd, distance, neighbour)) {
      farthest = i
      farthestOrd = neighbour
      farthestDistance = distance
    }
  }
  return farthest
}

function linkFrom(pass: NearestLinkPass, host: number, ord: number): boolean {
  const adjacency = pass.state.adjacency
  const base = layerBase(adjacency, host, 0)
  if (base === ABSENT) return false
  const list = adjacency.level0.subarray(base + 1, base + 1 + adjacency.level0[base])
  if (list.includes(ord)) {
    pass.anchoredBy[ord] = host
    return true
  }
  if (list.length < pass.state.Mmax0) {
    adjacency.level0[base + list.length + 1] = ord
    adjacency.level0[base] = list.length + 1
    noteLinked(adjacency, ord)
    pass.nearest[host] = NOT_YET_FOUND
    pass.anchoredBy[ord] = host
    return true
  }
  const slot = replaceableSlot(pass, host, list)
  if (slot === -1) return false
  const replaced = list[slot]
  list[slot] = ord
  noteUnlinked(adjacency, replaced)
  noteLinked(adjacency, ord)
  pass.nearest[host] = NOT_YET_FOUND
  pass.anchoredBy[ord] = host
  return true
}

export function linkFromNearest(state: HNSWGraphState): void {
  drain(linkFromNearestSteps(state, newPace()))
}

export function* linkFromNearestSteps(state: HNSWGraphState, pace: Pace): Steps {
  const adjacency = state.adjacency
  const slots = adjacencySlots(adjacency)
  if (slots > 0) reachNode(adjacency, slots - 1)
  const pass: NearestLinkPass = {
    state,
    distance: nodeDistanceFunction(state, state.buildMetric),
    nearest: new Int32Array(slots).fill(NOT_YET_FOUND),
    anchoredBy: new Int32Array(slots).fill(NOT_ANCHORED),
  }
  for (let ord = 0; ord < slots; ord++) {
    if (stepTaken(pace)) yield
    if (Atomics.load(adjacency.nearestLinkDue, ord) !== 1) continue
    Atomics.store(adjacency.nearestLinkDue, ord, 0)
    if (!isLive(state, ord)) continue
    const nearest = nearestInList(pass, ord)
    if (nearest === -1 || linkFrom(pass, nearest, ord)) continue
    for (const host of fallbackHostsFor(pass, ord, nearest)) if (linkFrom(pass, host, ord)) break
  }
}
