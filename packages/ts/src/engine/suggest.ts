import { tokenize } from '../core/tokenizer'
import type { PartitionManager } from '../partitioning/manager'
import type { LanguageModule } from '../types/language'
import type { SuggestResult } from '../types/results'
import type { SuggestParams } from '../types/search'

interface MergedSuggestion {
  documentFrequency: number
  surfaceOccurrences: Map<string, number>
}

export function executeSuggest(
  manager: PartitionManager,
  language: LanguageModule,
  params: SuggestParams,
): SuggestResult {
  const t0 = performance.now()
  const limit = Math.max(1, Math.min(params.limit ?? 10, 100))
  const rawPrefix = params.prefix.trim()

  if (rawPrefix.length === 0) {
    return { terms: [], elapsed: performance.now() - t0 }
  }

  const unstemmed = tokenize(rawPrefix, language, { stem: false, removeStopWords: false })
  const lastToken =
    unstemmed.tokens.length > 0 ? unstemmed.tokens[unstemmed.tokens.length - 1].token : rawPrefix.toLowerCase()

  if (lastToken.length === 0) {
    return { terms: [], elapsed: performance.now() - t0 }
  }

  const stemmed = language.stemmer ? language.stemmer(lastToken) : lastToken

  const merged = new Map<string, MergedSuggestion>()
  const perPartitionLimit = limit * 2

  for (const partition of manager.getAllPartitions()) {
    for (const suggestion of partition.suggestTerms(lastToken, stemmed, perPartitionLimit)) {
      let entry = merged.get(suggestion.token)
      if (!entry) {
        entry = { documentFrequency: 0, surfaceOccurrences: new Map() }
        merged.set(suggestion.token, entry)
      }
      entry.documentFrequency += suggestion.documentFrequency
      for (const s of suggestion.surfaces) {
        entry.surfaceOccurrences.set(s.surface, (entry.surfaceOccurrences.get(s.surface) ?? 0) + s.occurrences)
      }
    }
  }

  const terms = Array.from(merged.values())
    .map(entry => ({ term: pickDisplaySurface(entry.surfaceOccurrences), documentFrequency: entry.documentFrequency }))
    .sort((a, b) => b.documentFrequency - a.documentFrequency || (a.term < b.term ? -1 : 1))

  if (terms.length > limit) terms.length = limit

  return { terms, elapsed: performance.now() - t0 }
}

function pickDisplaySurface(surfaceOccurrences: Map<string, number>): string {
  let best = ''
  let bestCount = -1
  for (const [surface, occurrences] of surfaceOccurrences) {
    if (occurrences > bestCount || (occurrences === bestCount && surface < best)) {
      best = surface
      bestCount = occurrences
    }
  }
  return best
}
