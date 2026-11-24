import type { LanguageModule } from '../../types/language'
import type { PrefixCompletion } from '../expansion/host'
import type { PartialWordAnalysis } from '../partition/partial-words/spellings'
import type { AddedWord, PartialWordRequest } from '../partition/partial-words/types'
import type { PartitionReadState } from '../partition/read-state'

export interface NativeFoldedWordRequest {
  written: string
  own: string
  excluded: readonly string[]
  tolerance: number
  prefixLength: number
}

export interface NativeFoldedResult {
  variants: string[]
  typoMatches: string[]
}

export interface FoldedExpansionModule {
  terms(
    states: readonly PartitionReadState[],
    language: LanguageModule,
    words: readonly NativeFoldedWordRequest[],
  ): NativeFoldedResult[] | null
  completions(
    states: readonly PartitionReadState[],
    language: LanguageModule,
    typed: string,
    own: string,
    limit: number,
  ): PrefixCompletion[] | null
  partialWords(
    states: readonly PartitionReadState[],
    language: LanguageModule,
    analysis: PartialWordAnalysis,
    requests: readonly PartialWordRequest[],
  ): AddedWord[][] | null
}
