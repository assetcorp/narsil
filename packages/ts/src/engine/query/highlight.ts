import { tokenize } from '../../core/tokenizer'
import { highlightField } from '../../highlighting/highlighter'
import type { LanguageModule } from '../../types/language'
import type { HighlightMatch, Hit } from '../../types/results'
import type { IndexConfig } from '../../types/schema'
import type { QueryParams } from '../../types/search'

export function applyHighlights<T>(
  hits: Array<Hit<T>>,
  params: QueryParams,
  language: LanguageModule,
  config: IndexConfig,
): void {
  if (!params.highlight) return

  const queryTokenResult = tokenize(params.term ?? '', language, {
    stem: true,
    removeStopWords: true,
    customTokenizer: config.tokenizer,
    stopWordOverride: config.stopWords,
  })

  for (const hit of hits) {
    const highlights: Record<string, HighlightMatch> = {}
    for (const field of params.highlight.fields) {
      const doc = hit.document as Record<string, unknown>
      const fieldValue = doc[field]
      if (typeof fieldValue === 'string') {
        highlights[field] = highlightField(fieldValue, queryTokenResult.tokens, language, {
          preTag: params.highlight.preTag,
          postTag: params.highlight.postTag,
          maxSnippetLength: params.highlight.maxSnippetLength,
        })
      }
    }
    hit.highlights = highlights
  }
}
