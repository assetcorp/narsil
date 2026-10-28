import type { ResolvedAnalysis } from '../../analysis/registry'
import { partialWordsToHighlight } from '../../core/partition/partial-words/registry'
import type { SynonymLookup } from '../../core/synonyms/types'
import { tokenize } from '../../core/tokenizer'
import { highlightField, type PartialWordHighlight } from '../../highlighting/highlighter'
import { partialFieldsOf } from '../../schema/validator'
import { DEFAULT_FUZZY_PREFIX_LENGTH } from '../../search/constants'
import type { LanguageModule } from '../../types/language'
import type { HighlightMatch, Hit } from '../../types/results'
import type { SchemaDefinition } from '../../types/schema'
import type { QueryParams } from '../../types/search'

type QueryToken = { token: string; position: number }

interface PartialWordTagging {
  fields: ReadonlySet<string>
  highlight: PartialWordHighlight
}

function writtenWordsOf(params: QueryParams, language: LanguageModule, analysis: ResolvedAnalysis): QueryToken[] {
  return tokenize(params.term ?? '', language, {
    stem: false,
    removeStopWords: true,
    customTokenizer: analysis.customTokenizer,
    stopWordOverride: analysis.stopWords,
  }).tokens
}

function partialWordTagging(
  params: QueryParams,
  schema: SchemaDefinition,
  queryTokens: readonly QueryToken[],
  written: readonly QueryToken[],
  analysis: ResolvedAnalysis,
): PartialWordTagging | null {
  if (params.partialWords !== true || params.exact === true) return null
  const fields = partialFieldsOf(schema).filter(field => params.fields === undefined || params.fields.includes(field))
  if (fields.length === 0) return null

  const words = partialWordsToHighlight(queryTokens, written)
  if (words.length === 0) return null

  return {
    fields: new Set(fields),
    highlight: { words, customTokenizer: analysis.customTokenizer, stopWordOverride: analysis.stopWords },
  }
}

export function applyHighlights<T>(
  hits: Array<Hit<T>>,
  params: QueryParams,
  language: LanguageModule,
  analysis: ResolvedAnalysis,
  schema: SchemaDefinition,
  readStoredDocument?: (docId: string) => Record<string, unknown> | undefined,
  synonymLookup?: SynonymLookup | null,
): void {
  if (!params.highlight) return

  const queryTokenResult = tokenize(params.term ?? '', language, {
    stem: true,
    removeStopWords: true,
    customTokenizer: analysis.customTokenizer,
    stopWordOverride: analysis.stopWords,
  })
  const queryTokens = queryTokenResult.tokens
  const usesPrefix = params.prefix === true && params.exact !== true && queryTokens.length > 0
  const usesPartialWords = params.partialWords === true && params.exact !== true && queryTokens.length > 0
  const written = usesPrefix || usesPartialWords ? writtenWordsOf(params, language, analysis) : []

  let prefixToken: string | undefined
  let completedToken: string | undefined
  if (usesPrefix) {
    const lastToken = queryTokens[queryTokens.length - 1]
    for (const t of written) {
      if (t.position === lastToken.position) {
        prefixToken = t.token
        completedToken = lastToken.token
        break
      }
    }
  }
  const partialWords = usesPartialWords ? partialWordTagging(params, schema, queryTokens, written, analysis) : null
  const synonyms = params.exact === true ? undefined : synonymLookup?.expand(queryTokens.map(qt => qt.token))?.tokens

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
        highlights[field] = highlightField(fieldValue, queryTokens, language, {
          preTag: params.highlight.preTag,
          postTag: params.highlight.postTag,
          maxSnippetLength: params.highlight.maxSnippetLength,
          prefixToken,
          completedToken,
          tolerance: params.exact === true ? 0 : (params.tolerance ?? 0),
          prefixLength: params.prefixLength ?? DEFAULT_FUZZY_PREFIX_LENGTH,
          partialWords: partialWords?.fields.has(field) === true ? partialWords.highlight : undefined,
          synonyms,
        })
      }
    }
    hit.highlights = highlights
  }
}
