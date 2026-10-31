import { tokenize } from '../core/tokenizer'
import { ErrorCodes, NarsilError } from '../errors'
import type { LanguageModule } from '../types/language'
import type { CustomTokenizer, StopWordOverride } from '../types/schema'
import type { QueryPhrases } from './phrase-analysis'
import type * as PhraseModule from './phrase-module'
import { holdsQuoteCharacter, QUOTE_CHARACTER } from './quotes'

export type PhraseCode = typeof PhraseModule

export interface PhraseAnalysis {
  stopWords?: StopWordOverride
  customTokenizer?: CustomTokenizer
}

let loaded: PhraseCode | null = null
let loading: Promise<PhraseCode> | null = null

export function requireLoadedPhraseCode(): PhraseCode {
  if (loaded === null) {
    throw new NarsilError(ErrorCodes.SEARCH_PHRASE_NOT_READY, 'The phrase code has not loaded. Try the query again')
  }
  return loaded
}

function loadPhraseCode(): Promise<PhraseCode> {
  if (loading === null) {
    loading = import('./phrase-module').then(
      code => {
        loaded = code
        return code
      },
      (err: unknown) => {
        loading = null
        throw new NarsilError(
          ErrorCodes.SEARCH_PHRASE_NOT_READY,
          'The phrase code failed to load. Remove the quotes, or try again once it can load',
          { cause: err instanceof Error ? err.message : String(err) },
        )
      },
    )
  }
  return loading
}

export function loadPhraseCodeFor(term: string | undefined): Promise<PhraseCode> | null {
  if (loaded !== null || term === undefined || !holdsQuoteCharacter(term)) return null
  return loadPhraseCode()
}

export function analyseQueryPhrases(
  term: string,
  language: LanguageModule,
  analysis: PhraseAnalysis,
): QueryPhrases | null {
  if (!holdsQuoteCharacter(term)) return null
  return requireLoadedPhraseCode().analyseQueryPhrases(
    term.split(QUOTE_CHARACTER),
    text =>
      tokenize(text, language, {
        stem: true,
        removeStopWords: true,
        customTokenizer: analysis.customTokenizer,
        stopWordOverride: analysis.stopWords,
      }).tokens,
  )
}
