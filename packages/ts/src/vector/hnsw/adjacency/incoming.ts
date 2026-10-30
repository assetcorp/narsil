import { type Adjacency, reachNode } from './views'

export function incomingCount(adj: Adjacency, ord: number): number {
  if (ord < 0 || !reachNode(adj, ord)) return 0
  return Atomics.load(adj.incoming, ord)
}

export function noteLinked(adj: Adjacency, ord: number): void {
  if (ord < 0 || !reachNode(adj, ord)) return
  Atomics.add(adj.incoming, ord, 1)
}

export function noteUnlinked(adj: Adjacency, ord: number): number {
  if (ord < 0 || !reachNode(adj, ord)) return 0
  Atomics.store(adj.nearestLinkDue, ord, 1)
  for (;;) {
    const seen = Atomics.load(adj.incoming, ord)
    if (seen <= 0) return 0
    if (Atomics.compareExchange(adj.incoming, ord, seen, seen - 1) === seen) return seen - 1
  }
}

export function releaseUnlessLast(adj: Adjacency, ord: number): boolean {
  if (ord < 0 || !reachNode(adj, ord)) return true
  for (;;) {
    const seen = Atomics.load(adj.incoming, ord)
    if (seen <= 1) return false
    if (Atomics.compareExchange(adj.incoming, ord, seen, seen - 1) !== seen) continue
    Atomics.store(adj.nearestLinkDue, ord, 1)
    return true
  }
}

function holdsNodeAt(adj: Adjacency, ord: number): boolean {
  return ord >= 0 && ord < adj.nodeLevels.length && adj.nodeLevels[ord] !== 0
}

export function countLinksOutOf(adj: Adjacency, ord: number, step: 1 | -1): void {
  if (!holdsNodeAt(adj, ord)) return
  const incoming = adj.incoming
  const level0 = adj.level0
  const base = ord * adj.level0Stride
  const count = level0[base]
  for (let i = 1; i <= count; i++) {
    const neighbour = level0[base + i]
    if (neighbour === ord || !holdsNodeAt(adj, neighbour)) continue
    if (incoming[neighbour] + step >= 0) incoming[neighbour] += step
  }
}

export function countEveryLink(adj: Adjacency, slots: number): void {
  for (let ord = 0; ord < slots; ord++) countLinksOutOf(adj, ord, 1)
}
