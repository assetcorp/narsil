import { incomingCount, noteLinked, noteUnlinked, releaseUnlessLast, writeNeighbors } from './adjacency'
import { GRAPH_UNLINKED_NODES } from './handles'
import { type HNSWGraphState, isTombstoned, nodeExists } from './shared'
import { appendToList, type DistanceList, ensureListCapacity } from './workspace'

export function isLive(state: HNSWGraphState, ord: number): boolean {
  return nodeExists(state, ord) && !isTombstoned(state, ord)
}

export function noteNodeLeftUnlinked(state: HNSWGraphState): void {
  Atomics.store(state.header, GRAPH_UNLINKED_NODES, 1)
}

function listHolds(list: DistanceList, ord: number): boolean {
  for (let i = 0; i < list.size; i++) if (list.ords[i] === ord) return true
  return false
}

function collectDropped(sorted: DistanceList, kept: DistanceList, dropped: DistanceList): void {
  dropped.size = 0
  let next = 0
  for (let i = 0; i < sorted.size; i++) {
    const ord = sorted.ords[i]
    if (next < kept.size && kept.ords[next] === ord) {
      next += 1
      continue
    }
    if (listHolds(kept, ord)) continue
    appendToList(dropped, ord, sorted.distances[i])
  }
}

function replaceFarthestShared(
  state: HNSWGraphState,
  kept: DistanceList,
  held: (ord: number) => boolean,
  ord: number,
  distance: number,
): boolean {
  const tried = new Set<number>()
  for (;;) {
    let farthest = -1
    for (let k = 0; k < kept.size; k++) {
      if (tried.has(k) || incomingCount(state.adjacency, kept.ords[k]) < 2) continue
      if (farthest === -1 || kept.distances[k] > kept.distances[farthest]) farthest = k
    }
    if (farthest === -1) return false
    tried.add(farthest)
    const replaced = kept.ords[farthest]
    if (held(replaced) && !releaseUnlessLast(state.adjacency, replaced)) continue
    kept.ords[farthest] = ord
    kept.distances[farthest] = distance
    return true
  }
}

export function writeKeepingLastLinks(
  state: HNSWGraphState,
  ord: number,
  sorted: DistanceList,
  kept: DistanceList,
  held: (candidate: number) => boolean,
): void {
  const adjacency = state.adjacency
  const limit = state.Mmax0
  const dropped = state.workspace.droppedLinks
  collectDropped(sorted, kept, dropped)
  ensureListCapacity(kept, limit)
  for (let i = 0; i < dropped.size; i++) {
    const candidate = dropped.ords[i]
    if (!held(candidate)) continue
    if (!isLive(state, candidate)) {
      noteUnlinked(adjacency, candidate)
      continue
    }
    if (releaseUnlessLast(adjacency, candidate)) continue
    if (kept.size < limit) {
      appendToList(kept, candidate, dropped.distances[i])
      continue
    }
    if (replaceFarthestShared(state, kept, held, candidate, dropped.distances[i])) continue
    noteUnlinked(adjacency, candidate)
    noteNodeLeftUnlinked(state)
  }
  for (let k = 0; k < kept.size; k++) if (!held(kept.ords[k])) noteLinked(adjacency, kept.ords[k])
  writeNeighbors(adjacency, ord, 0, kept.ords, kept.size)
}
