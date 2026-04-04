import { tokenize } from '../core/tokenizer'
import type { PartitionManager } from '../partitioning/manager'
import type { LanguageModule } from '../types/language'
import type { SuggestResult } from '../types/results'
import type { SuggestParams } from '../types/search'

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
  const prefixes = stemmed !== lastToken ? [lastToken, stemmed] : [lastToken]

  const partitions = manager.getAllPartitions()
  const merged = new Map<string, number>()
  const perPartitionLimit = limit * 2

  for (const partition of partitions) {
    const seen = new Set<string>()
    for (const prefix of prefixes) {
      const suggestions = partition.suggestTerms(prefix, perPartitionLimit)
      for (const s of suggestions) {
        if (seen.has(s.term)) continue
        seen.add(s.term)
        merged.set(s.term, (merged.get(s.term) ?? 0) + s.documentFrequency)
      }
    }
  }

  const terms = Array.from(merged.entries())
    .map(([term, documentFrequency]) => ({ term, documentFrequency }))
    .sort((a, b) => b.documentFrequency - a.documentFrequency)

  if (terms.length > limit) terms.length = limit

  return { terms, elapsed: performance.now() - t0 }
}
