import type { ResolvedAnalysis } from '../../analysis/registry'
import { tokenize } from '../../core/tokenizer'
import { highlightField } from '../../highlighting/highlighter'
import type { LanguageModule } from '../../types/language'
import type { HighlightMatch, Hit } from '../../types/results'
import type { QueryParams } from '../../types/search'

export function applyHighlights<T>(
  hits: Array<Hit<T>>,
  params: QueryParams,
  language: LanguageModule,
  analysis: ResolvedAnalysis,
  readStoredDocument?: (docId: string) => Record<string, unknown> | undefined,
): void {
  if (!params.highlight) return

  const queryTokenResult = tokenize(params.term ?? '', language, {
    stem: true,
    removeStopWords: true,
    customTokenizer: analysis.customTokenizer,
    stopWordOverride: analysis.stopWords,
  })

  let prefixToken: string | undefined
  if (params.prefix === true && params.exact !== true && queryTokenResult.tokens.length > 0) {
    const lastPosition = queryTokenResult.tokens[queryTokenResult.tokens.length - 1].position
    const unstemmed = tokenize(params.term ?? '', language, {
      stem: false,
      removeStopWords: true,
      customTokenizer: analysis.customTokenizer,
      stopWordOverride: analysis.stopWords,
    })
    for (const t of unstemmed.tokens) {
      if (t.position === lastPosition) {
        prefixToken = t.token
        break
      }
    }
  }

  for (const hit of hits) {
    const highlights: Record<string, HighlightMatch> = {}
    const projected = hit.document as Record<string, unknown>
    let stored: Record<string, unknown> | undefined
    for (const field of params.highlight.fields) {
      let fieldValue = projected[field]
      if (typeof fieldValue !== 'string' && readStoredDocument !== undefined) {
        stored ??= readStoredDocument(hit.id)
        fieldValue = stored?.[field]
      }
      if (typeof fieldValue === 'string') {
        highlights[field] = highlightField(fieldValue, queryTokenResult.tokens, language, {
          preTag: params.highlight.preTag,
          postTag: params.highlight.postTag,
          maxSnippetLength: params.highlight.maxSnippetLength,
          prefixToken,
        })
      }
    }
    hit.highlights = highlights
  }
}
