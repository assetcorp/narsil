import type { SerializedSurfaceForms } from '../types/internal'

export interface SurfaceFormCandidate {
  surface: string
  token: string
  occurrences: number
}

export interface SurfaceRegistryReader {
  candidatesForPrefix(prefix: string): SurfaceFormCandidate[]
  stemChangedTotalFor(token: string): number
  size(): number
  serialize(): SerializedSurfaceForms
}

export interface SurfaceRegistry extends SurfaceRegistryReader {
  adopt(reader: SurfaceRegistryReader): void
  detach(): void
  tokenOf(surface: string): string | undefined
  add(surface: string, token: string, occurrences: number): void
  subtract(surface: string, occurrences: number): void
  clear(): void
  deserialize(data: SerializedSurfaceForms): void
}

interface SurfaceEntry {
  token: string
  count: number
}

export function createSurfaceRegistry(): SurfaceRegistry {
  const entries = new Map<string, SurfaceEntry>()
  const buckets = new Map<string, Set<string>>()
  let totalsByToken: Map<string, number> | null = null
  let source: SurfaceRegistryReader | null = null

  function track(surface: string): void {
    const ch = surface[0]
    let bucket = buckets.get(ch)
    if (!bucket) {
      bucket = new Set()
      buckets.set(ch, bucket)
    }
    bucket.add(surface)
  }

  function untrack(surface: string): void {
    const ch = surface[0]
    const bucket = buckets.get(ch)
    if (bucket) {
      bucket.delete(surface)
      if (bucket.size === 0) buckets.delete(ch)
    }
  }

  function adjustTotals(token: string, delta: number): void {
    if (!totalsByToken || delta === 0) return
    const next = (totalsByToken.get(token) ?? 0) + delta
    if (next <= 0) totalsByToken.delete(token)
    else totalsByToken.set(token, next)
  }

  const registry: SurfaceRegistry = {
    adopt(reader): void {
      entries.clear()
      buckets.clear()
      totalsByToken = null
      source = reader
    },

    detach(): void {
      if (source === null) return
      const data = source.serialize()
      registry.deserialize(data)
    },

    tokenOf(surface: string): string | undefined {
      if (source !== null) return source.candidatesForPrefix(surface).find(entry => entry.surface === surface)?.token
      return entries.get(surface)?.token
    },

    add(surface: string, token: string, occurrences: number): void {
      if (surface.length === 0 || token.length === 0 || occurrences <= 0) return
      if (surface === token) return
      registry.detach()
      const existing = entries.get(surface)
      if (existing) {
        existing.count += occurrences
        adjustTotals(existing.token, occurrences)
        return
      }
      entries.set(surface, { token, count: occurrences })
      track(surface)
      adjustTotals(token, occurrences)
    },

    subtract(surface: string, occurrences: number): void {
      if (occurrences <= 0) return
      registry.detach()
      const existing = entries.get(surface)
      if (!existing) return
      const removed = Math.min(occurrences, existing.count)
      existing.count -= occurrences
      adjustTotals(existing.token, -removed)
      if (existing.count <= 0) {
        entries.delete(surface)
        untrack(surface)
      }
    },

    candidatesForPrefix(prefix: string): SurfaceFormCandidate[] {
      if (source !== null) return source.candidatesForPrefix(prefix)
      if (prefix.length === 0) return []
      const bucket = buckets.get(prefix[0])
      if (!bucket) return []
      const results: SurfaceFormCandidate[] = []
      for (const surface of bucket) {
        if (surface.length < prefix.length || !surface.startsWith(prefix)) continue
        const entry = entries.get(surface)
        if (!entry) continue
        results.push({ surface, token: entry.token, occurrences: entry.count })
      }
      return results
    },

    stemChangedTotalFor(token: string): number {
      if (source !== null) return source.stemChangedTotalFor(token)
      if (!totalsByToken) {
        totalsByToken = new Map()
        for (const entry of entries.values()) {
          totalsByToken.set(entry.token, (totalsByToken.get(entry.token) ?? 0) + entry.count)
        }
      }
      return totalsByToken.get(token) ?? 0
    },

    size(): number {
      if (source !== null) return source.size()
      return entries.size
    },

    clear(): void {
      source = null
      entries.clear()
      buckets.clear()
      totalsByToken = null
    },

    serialize(): SerializedSurfaceForms {
      if (source !== null) return source.serialize()
      const result: SerializedSurfaceForms = Object.create(null)
      for (const [surface, entry] of entries) {
        result[surface] = [entry.count, entry.token]
      }
      return result
    },

    deserialize(data: SerializedSurfaceForms): void {
      source = null
      entries.clear()
      buckets.clear()
      totalsByToken = null
      for (const surface of Object.keys(data)) {
        if (surface.length === 0) continue
        const value = data[surface]
        if (!Array.isArray(value) || typeof value[0] !== 'number' || typeof value[1] !== 'string') continue
        const count = value[0]
        const token = value[1]
        if (!Number.isFinite(count) || count <= 0 || token.length === 0 || token === surface) continue
        entries.set(surface, { token, count: Math.floor(count) })
        track(surface)
      }
    },
  }
  return registry
}
