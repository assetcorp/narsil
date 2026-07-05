import type { SerializedSurfaceForms } from '../types/internal'

export interface SurfaceFormCandidate {
  surface: string
  token: string
  occurrences: number
}

/**
 * Tracks the unstemmed surface form behind every indexed token so
 * suggestions and prefix expansion can work in the vocabulary users
 * actually type, while the inverted index stays stemmed.
 */
export interface SurfaceRegistry {
  add(surface: string, token: string, occurrences: number): void
  subtract(surface: string, occurrences: number): void
  candidatesForPrefix(prefix: string): SurfaceFormCandidate[]
  size(): number
  clear(): void
  serialize(): SerializedSurfaceForms
  deserialize(data: SerializedSurfaceForms): void
}

interface SurfaceEntry {
  token: string
  count: number
}

export function createSurfaceRegistry(): SurfaceRegistry {
  const entries = new Map<string, SurfaceEntry>()
  const buckets = new Map<string, Set<string>>()

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

  return {
    add(surface: string, token: string, occurrences: number): void {
      if (surface.length === 0 || token.length === 0 || occurrences <= 0) return
      const existing = entries.get(surface)
      if (existing) {
        existing.count += occurrences
        return
      }
      entries.set(surface, { token, count: occurrences })
      track(surface)
    },

    subtract(surface: string, occurrences: number): void {
      if (occurrences <= 0) return
      const existing = entries.get(surface)
      if (!existing) return
      existing.count -= occurrences
      if (existing.count <= 0) {
        entries.delete(surface)
        untrack(surface)
      }
    },

    candidatesForPrefix(prefix: string): SurfaceFormCandidate[] {
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

    size(): number {
      return entries.size
    },

    clear(): void {
      entries.clear()
      buckets.clear()
    },

    serialize(): SerializedSurfaceForms {
      const result: SerializedSurfaceForms = Object.create(null)
      for (const [surface, entry] of entries) {
        result[surface] = entry.token === surface ? entry.count : [entry.count, entry.token]
      }
      return result
    },

    deserialize(data: SerializedSurfaceForms): void {
      entries.clear()
      buckets.clear()
      for (const surface of Object.keys(data)) {
        if (surface.length === 0) continue
        const value = data[surface]
        let token: string
        let count: number
        if (typeof value === 'number') {
          token = surface
          count = value
        } else if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'string') {
          count = value[0]
          token = value[1]
        } else {
          continue
        }
        if (!Number.isFinite(count) || count <= 0 || token.length === 0) continue
        entries.set(surface, { token, count: Math.floor(count) })
        track(surface)
      }
    },
  }
}
