import type { SerializedSurfaceForms } from '../../types/internal'
import type { SurfaceFormCandidate, SurfaceRegistryReader } from '../surface-registry'
import type { GrowingSegment } from './growing'
import type { SurfaceTable } from './surface-table'

function startsWith(table: SurfaceTable, ordinal: number, prefix: string): boolean {
  const strings = table.strings
  if (strings.termLength[ordinal] < prefix.length) return false
  const offset = strings.termOffset[ordinal]
  for (let at = 0; at < prefix.length; at++) if (strings.units[offset + at] !== prefix.charCodeAt(at)) return false
  return true
}

export function growingSurfaceReader(segment: GrowingSegment): SurfaceRegistryReader {
  return {
    candidatesForPrefix(prefix: string): SurfaceFormCandidate[] {
      const table = segment.surfaces
      if (table === null || prefix.length === 0) return []
      const results: SurfaceFormCandidate[] = []
      const terms = segment.postings.terms
      let link = table.strings.firstUnitHead[prefix.charCodeAt(0)]
      while (link !== 0) {
        const ordinal = link - 1
        link = table.strings.firstUnitNext[ordinal]
        if (table.count[ordinal] === 0 || !startsWith(table, ordinal, prefix)) continue
        results.push({
          surface: table.textAt(ordinal),
          token: terms.tokens[table.token[ordinal]],
          occurrences: table.count[ordinal],
        })
      }
      return results
    },

    stemChangedTotalFor(token: string): number {
      const terms = segment.postings.terms
      const ordinal = terms.ids.get(token)
      return ordinal === undefined ? 0 : terms.surfaceOccurrences[ordinal]
    },

    size(): number {
      return segment.surfaces?.strings.header[1] ?? 0
    },

    serialize(): SerializedSurfaceForms {
      const result: SerializedSurfaceForms = Object.create(null)
      const table = segment.surfaces
      if (table === null) return result
      const terms = segment.postings.terms
      for (const ordinal of table.liveEntries())
        result[table.textAt(ordinal)] = [table.count[ordinal], terms.tokens[table.token[ordinal]]]
      return result
    },
  }
}
