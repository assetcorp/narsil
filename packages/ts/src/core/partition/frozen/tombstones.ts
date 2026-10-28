export interface FrozenTombstones {
  readonly size: number
  readonly revision: number
  has(internalId: number): boolean
  add(internalId: number): boolean
  at(arrival: number): number
  values(): IterableIterator<number>
}

export function createFrozenTombstones(): FrozenTombstones {
  const removed = new Set<number>()
  const arrivals: number[] = []
  let revision = 0

  return {
    get size() {
      return removed.size
    },
    get revision() {
      return revision
    },
    has(internalId: number): boolean {
      return removed.size > 0 && removed.has(internalId)
    },
    add(internalId: number): boolean {
      if (removed.has(internalId)) return false
      removed.add(internalId)
      arrivals.push(internalId)
      revision++
      return true
    },
    at(arrival: number): number {
      return arrivals[arrival]
    },
    values(): IterableIterator<number> {
      return removed.values()
    },
  }
}
