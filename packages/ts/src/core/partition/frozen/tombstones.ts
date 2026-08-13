export interface FrozenTombstones {
  readonly size: number
  readonly revision: number
  has(internalId: number): boolean
  add(internalId: number): boolean
}

export function createFrozenTombstones(): FrozenTombstones {
  const removed = new Set<number>()
  let revision = 0

  return {
    get size() {
      return removed.size
    },
    get revision() {
      return revision
    },
    has(internalId: number): boolean {
      return removed.has(internalId)
    },
    add(internalId: number): boolean {
      if (removed.has(internalId)) return false
      removed.add(internalId)
      revision++
      return true
    },
  }
}
