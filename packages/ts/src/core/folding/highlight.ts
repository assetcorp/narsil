import type { FoldedHighlight } from '../../highlighting/highlighter'
import type { QueryPhrases } from '../../search/phrase-analysis'
import type { LanguageModule } from '../../types/language'
import { spellingFoldsOf } from './keys'

type QueryToken = { token: string; position: number }

export interface FoldedHighlightRequest {
  language: LanguageModule
  queryTokens: readonly QueryToken[]
  written: readonly QueryToken[]
  quoted: QueryPhrases | null
  tolerance: number
  completedToken: string | undefined
  prefixToken: string | undefined
}

export function foldedHighlightOf(request: FoldedHighlightRequest): FoldedHighlight {
  const folds = spellingFoldsOf(request.language)
  const writtenAt = new Map(request.written.map(entry => [entry.position, entry.token]))
  const phraseKeys = new Set<string>()
  for (const phrase of request.quoted?.phrases ?? []) {
    for (let at = 0; at < phrase.tokens.length; at++) {
      phraseKeys.add(folds.keyOf(phrase.written?.[at] ?? phrase.tokens[at]))
    }
  }
  const prefix = request.prefixToken === undefined ? '' : folds.foldOf(request.prefixToken)
  return {
    keyOf: folds.keyOf,
    foldOf: folds.foldOf,
    keys: request.queryTokens.map(query => ({
      key: folds.keyOf(writtenAt.get(query.position) ?? query.token),
      tolerance: query.token === request.completedToken ? 0 : request.tolerance,
    })),
    phraseKeys,
    ...(prefix.length > 0 ? { prefix } : {}),
  }
}
