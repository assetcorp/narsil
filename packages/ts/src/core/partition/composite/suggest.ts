import { compareCodePoints } from '../../ordering'
import type { PartitionReadState } from '../read-state'
import { expandTermPrefix, type PartitionSuggestion, suggestDisplayTerms } from '../suggestions'

export function compositeSuggestTerms(
  subs: readonly PartitionReadState[],
  surfacePrefix: string,
  stemmedPrefix: string,
  limit: number,
): PartitionSuggestion[] {
  const merged = new Map<string, { documentFrequency: number; surfaceOccurrences: Map<string, number> }>()

  for (const sub of subs) {
    for (const suggestion of suggestDisplayTerms(sub, surfacePrefix, stemmedPrefix, limit)) {
      let entry = merged.get(suggestion.token)
      if (entry === undefined) {
        entry = { documentFrequency: 0, surfaceOccurrences: new Map() }
        merged.set(suggestion.token, entry)
      }
      entry.documentFrequency += suggestion.documentFrequency
      for (const surface of suggestion.surfaces) {
        entry.surfaceOccurrences.set(
          surface.surface,
          (entry.surfaceOccurrences.get(surface.surface) ?? 0) + surface.occurrences,
        )
      }
    }
  }

  const suggestions: PartitionSuggestion[] = []
  for (const [token, entry] of merged) {
    const surfaces = Array.from(entry.surfaceOccurrences, ([surface, occurrences]) => ({ surface, occurrences }))
    surfaces.sort((a, b) => b.occurrences - a.occurrences || compareCodePoints(a.surface, b.surface))
    suggestions.push({ token, documentFrequency: entry.documentFrequency, surfaces })
  }

  suggestions.sort((a, b) => b.documentFrequency - a.documentFrequency || compareCodePoints(a.token, b.token))
  if (suggestions.length > limit) suggestions.length = limit
  return suggestions
}

export function compositeExpandTermPrefix(
  subs: readonly PartitionReadState[],
  surfacePrefix: string,
  stemmedToken: string,
  maxExpansions: number,
): string[] {
  const expansions: string[] = []
  const seen = new Set<string>()
  for (const sub of subs) {
    for (const term of expandTermPrefix(sub, surfacePrefix, stemmedToken, maxExpansions)) {
      if (seen.has(term)) continue
      seen.add(term)
      expansions.push(term)
      if (expansions.length === maxExpansions) return expansions
    }
  }
  return expansions
}
