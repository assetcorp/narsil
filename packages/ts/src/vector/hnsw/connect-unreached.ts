import { noteFallback } from '../native/backend'
import { nativeFieldFor } from '../native/field'
import { nativeConnect } from '../native/writes'
import { adjacencySlots, incomingCount, layerBase, noteLinked, noteUnlinked } from './adjacency'
import { ABSENT } from './adjacency/views'
import { GRAPH_UNLINKED_NODES } from './handles'
import { isLive } from './last-links'
import { lockGraphExclusive, unlockGraphExclusive } from './locks'
import { entryPointOf, type HNSWGraphState, nodeDistanceFunction, nodeExists } from './shared'

interface Walk {
  reached: Uint8Array
  queue: Int32Array
  head: number
  tail: number
}

type HostTest = (state: HNSWGraphState, host: number) => boolean

function walkFrom(state: HNSWGraphState, walk: Walk, start: number): void {
  const adjacency = state.adjacency
  if (walk.reached[start] === 1) return
  walk.reached[start] = 1
  walk.queue[walk.tail++] = start
  while (walk.head < walk.tail) {
    const ord = walk.queue[walk.head++]
    const base = layerBase(adjacency, ord, 0)
    if (base === ABSENT) continue
    const count = adjacency.level0[base]
    for (let i = 1; i <= count; i++) {
      const next = adjacency.level0[base + i]
      if (next < 0 || next >= walk.reached.length || walk.reached[next] === 1 || !nodeExists(state, next)) continue
      walk.reached[next] = 1
      walk.queue[walk.tail++] = next
    }
  }
}

function hasRoom(state: HNSWGraphState, host: number): boolean {
  const base = layerBase(state.adjacency, host, 0)
  return base !== ABSENT && state.adjacency.level0[base] < state.Mmax0
}

function holdsSharedLink(state: HNSWGraphState, host: number): boolean {
  const adjacency = state.adjacency
  const base = layerBase(adjacency, host, 0)
  if (base === ABSENT) return false
  const count = adjacency.level0[base]
  for (let i = 1; i <= count; i++) if (incomingCount(adjacency, adjacency.level0[base + i]) >= 2) return true
  return false
}

function listOf(state: HNSWGraphState, ord: number): Int32Array {
  const adjacency = state.adjacency
  const base = layerBase(adjacency, ord, 0)
  if (base === ABSENT) return new Int32Array(0)
  return adjacency.level0.slice(base + 1, base + 1 + adjacency.level0[base])
}

function nearestHost(
  state: HNSWGraphState,
  walk: Walk,
  orphan: number,
  nearby: { list: number[]; holds: Uint8Array },
  test: HostTest,
): number {
  const distance = nodeDistanceFunction(state, state.buildMetric)
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  const consider = (host: number): void => {
    if (host === orphan || walk.reached[host] !== 1 || !isLive(state, host) || !test(state, host)) return
    const away = distance(orphan, host)
    if (best === -1 || away < bestDistance) {
      best = host
      bestDistance = away
    }
  }
  for (const host of nearby.list) consider(host)
  for (const host of listOf(state, orphan))
    if (host >= 0 && host < walk.reached.length && nearby.holds[host] !== 1) consider(host)
  if (best !== -1) return best
  for (let host = 0; host < walk.reached.length; host++) consider(host)
  return best
}

function takeOutFarthestSharedLink(state: HNSWGraphState, host: number): void {
  const adjacency = state.adjacency
  const base = layerBase(adjacency, host, 0)
  if (base === ABSENT) return
  const distance = nodeDistanceFunction(state, state.buildMetric)
  const count = adjacency.level0[base]
  let farthest = -1
  let farthestDistance = Number.NEGATIVE_INFINITY
  for (let i = 1; i <= count; i++) {
    const neighbour = adjacency.level0[base + i]
    if (incomingCount(adjacency, neighbour) < 2) continue
    const away = distance(host, neighbour)
    if (farthest === -1 || away > farthestDistance) {
      farthest = i
      farthestDistance = away
    }
  }
  if (farthest === -1) return
  const taken = adjacency.level0[base + farthest]
  for (let i = farthest; i < count; i++) adjacency.level0[base + i] = adjacency.level0[base + i + 1]
  adjacency.level0[base] = count - 1
  noteUnlinked(adjacency, taken)
}

function appendTo(state: HNSWGraphState, host: number, orphan: number): void {
  const adjacency = state.adjacency
  const base = layerBase(adjacency, host, 0)
  if (base === ABSENT) return
  const count = adjacency.level0[base]
  adjacency.level0[base + count + 1] = orphan
  adjacency.level0[base] = count + 1
  noteLinked(adjacency, orphan)
}

export function connectUnreached(state: HNSWGraphState, nearby: ArrayLike<number>): void {
  const slots = adjacencySlots(state.adjacency)
  const entry = entryPointOf(state)
  if (entry < 0 || entry >= slots || !nodeExists(state, entry)) return
  const walk: Walk = { reached: new Uint8Array(slots), queue: new Int32Array(slots), head: 0, tail: 0 }
  walkFrom(state, walk, entry)
  const held = { list: [] as number[], holds: new Uint8Array(slots) }
  for (let i = 0; i < nearby.length; i++) {
    const ord = nearby[i]
    if (ord < 0 || ord >= slots || held.holds[ord] === 1) continue
    held.holds[ord] = 1
    held.list.push(ord)
  }
  for (let orphan = 0; orphan < slots; orphan++) {
    if (walk.reached[orphan] === 1 || !isLive(state, orphan)) continue
    let host = nearestHost(state, walk, orphan, held, hasRoom)
    if (host === -1) {
      host = nearestHost(state, walk, orphan, held, holdsSharedLink)
      if (host === -1) continue
      takeOutFarthestSharedLink(state, host)
    }
    appendTo(state, host, orphan)
    walkFrom(state, walk, orphan)
  }
}

function holdsUnlinkedNode(state: HNSWGraphState): boolean {
  const slots = adjacencySlots(state.adjacency)
  const entry = entryPointOf(state)
  const incoming = state.adjacency.incoming
  for (let ord = 0; ord < slots; ord++) {
    if (incoming[ord] === 0 && ord !== entry && isLive(state, ord)) return true
  }
  return false
}

function connectThroughEitherCore(state: HNSWGraphState, nearby: Int32Array): void {
  const field = nativeFieldFor(state)
  if (field !== null && nativeConnect(state, field, state.buildMetric, nearby)) return
  noteFallback('connect')
  connectUnreached(state, nearby)
}

export function connectAfterRemoval(state: HNSWGraphState, nearby: Int32Array): void {
  connectThroughEitherCore(state, nearby)
  Atomics.store(state.header, GRAPH_UNLINKED_NODES, 0)
}

export function connectAfterPlacement(state: HNSWGraphState, holdsGraphLock: boolean): void {
  if (Atomics.load(state.header, GRAPH_UNLINKED_NODES) === 0) return
  if (!holdsGraphLock) lockGraphExclusive(state.locks)
  try {
    if (Atomics.load(state.header, GRAPH_UNLINKED_NODES) === 0) return
    connectThroughEitherCore(state, new Int32Array(0))
    Atomics.store(state.header, GRAPH_UNLINKED_NODES, 0)
  } finally {
    if (!holdsGraphLock) unlockGraphExclusive(state.locks)
  }
}

export function baseNeighboursOfRemoved(state: HNSWGraphState, removed: readonly number[]): Int32Array {
  const leaving = new Set(removed)
  const nearby: number[] = []
  for (const ord of removed) {
    for (const neighbour of listOf(state, ord)) if (!leaving.has(neighbour)) nearby.push(neighbour)
  }
  return Int32Array.from(nearby)
}

export function linkEveryNodeAfterLoad(state: HNSWGraphState): void {
  if (holdsUnlinkedNode(state)) connectUnreached(state, new Int32Array(0))
  Atomics.store(state.header, GRAPH_UNLINKED_NODES, 0)
}
