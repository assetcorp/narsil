import type { AnalysedPhrase } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { PartitionIndex } from '../partition/partition-index'
import { type FoldedTermRequest, resolveFoldedPhrases, resolveFoldedTerms } from './resolve'

export function addFoldedTermTokens(added: Set<string>, request: FoldedTermRequest): void {
  for (const folded of resolveFoldedTerms(request) ?? []) {
    for (const token of folded.variants) added.add(token)
    for (const token of folded.typoMatches) added.add(token)
  }
}

export function foldedPhraseVariants(
  partitions: readonly PartitionIndex[],
  language: LanguageModule,
  phrases: readonly AnalysedPhrase[],
): string[] {
  const found = new Set<string>()
  for (const partition of partitions) {
    for (const phrase of resolveFoldedPhrases(partition, language, phrases)) {
      for (const variants of phrase.variants ?? []) for (const variant of variants) found.add(variant)
    }
  }
  return [...found]
}
