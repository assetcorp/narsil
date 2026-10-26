import type { VectorMetric } from '../brute-force'
import type { OpenStore } from './open-store'
import type { ArenaQueryVector, VectorStoreEntry } from './types'

export function entryAt(store: OpenStore, ordinal: number): VectorStoreEntry {
  return { vector: store.view.vectorAt(ordinal), magnitude: store.magnitudes[ordinal] }
}

export function createOrdinalReads(openStore: () => OpenStore | null, readable: (ordinal: number) => boolean) {
  function pairDistance(metric: VectorMetric): (ordA: number, ordB: number) => number {
    const open = openStore()
    if (open === null) return () => Number.POSITIVE_INFINITY
    const inner = open.view.pairDistance(metric)
    return (ordA, ordB) => (readable(ordA) && readable(ordB) ? inner(ordA, ordB) : Number.POSITIVE_INFINITY)
  }

  return {
    entryForOrdinal(ordinal: number): VectorStoreEntry | undefined {
      const open = openStore()
      if (open === null || !readable(ordinal)) return undefined
      return entryAt(open, ordinal)
    },

    distanceByOrdinal(ordA: number, ordB: number, metric: VectorMetric): number {
      const open = openStore()
      if (open === null || !readable(ordA) || !readable(ordB)) return Number.POSITIVE_INFINITY
      return open.view.distanceByOrdinal(ordA, ordB, metric)
    },

    distanceFromArena(prepared: ArenaQueryVector, ordinal: number, metric: VectorMetric): number {
      const open = openStore()
      if (open === null || !readable(ordinal)) return Number.POSITIVE_INFINITY
      return open.view.distanceFromArena(prepared, ordinal, metric)
    },

    queryDistance(prepared: ArenaQueryVector, metric: VectorMetric): (ordinal: number) => number {
      const open = openStore()
      if (open === null) return () => Number.POSITIVE_INFINITY
      const inner = open.view.queryDistance(prepared, metric)
      return ordinal => (readable(ordinal) ? inner(ordinal) : Number.POSITIVE_INFINITY)
    },

    ordinalDistance(from: number, metric: VectorMetric): (ordinal: number) => number {
      const pair = pairDistance(metric)
      return ordinal => pair(from, ordinal)
    },

    pairDistance,
  }
}
