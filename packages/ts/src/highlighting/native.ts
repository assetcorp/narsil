import { storedText } from '../core/stored-values/text'
import { nativeCoreLanguage } from '../core/tokenizer/native-analysis'
import type { LanguageModule } from '../types/language'
import type { HighlightMatch } from '../types/results'
import { noteFallback } from '../vector/native/backend'
import { NATIVE_NEEDS_ROOM } from '../vector/native/types'
import { DEFAULT_MAX_SNIPPET_LENGTH, NATIVE_FIRST_HIGHLIGHT_SPANS } from './constants'
import type { HighlightOptions } from './highlighter'

function unitsOf(text: string): Uint16Array {
  const units = new Uint16Array(text.length)
  for (let at = 0; at < text.length; at++) units[at] = text.charCodeAt(at)
  return units
}

export function nativeHighlight(
  text: string,
  terms: readonly { token: string; tolerance: number }[],
  language: LanguageModule,
  options?: HighlightOptions,
): HighlightMatch | null {
  if (options?.partialWords?.customTokenizer !== undefined || options?.partialWords?.stopWordOverride !== undefined)
    return null
  const selected = nativeCoreLanguage(language)
  if (selected === null) return null
  const preTag = unitsOf(options?.preTag ?? '<mark>')
  const postTag = unitsOf(options?.postTag ?? '</mark>')
  const maximum = options?.maxSnippetLength ?? DEFAULT_MAX_SNIPPET_LENGTH
  const query = {
    terms: terms.map(term => ({ term: unitsOf(term.token), tolerance: term.tolerance })),
    prefixLength: options?.prefixLength ?? 0,
    prefix: options?.prefixToken === undefined ? null : unitsOf(options.prefixToken),
    synonyms: (options?.synonyms ?? []).map(unitsOf),
    partialWords: options?.partialWords?.words.map(unitsOf) ?? null,
  }
  const textUnits = unitsOf(text)
  const length = new Uint32Array(1)
  let spans = Math.min(text.length, NATIVE_FIRST_HIGHLIGHT_SPANS)
  for (;;) {
    const snippet = new Uint16Array(text.length + 6 + spans * (preTag.length + postTag.length))
    const positions = new Uint32Array(spans * 2)
    const count = selected.core.highlight(
      selected.index,
      textUnits,
      query,
      preTag,
      postTag,
      maximum,
      snippet,
      positions,
      length,
    )
    if (count === -NATIVE_NEEDS_ROOM && spans < text.length) {
      spans = Math.min(text.length, spans * 2)
      continue
    }
    if (count < 0) {
      noteFallback('highlight')
      return null
    }
    const found: HighlightMatch['positions'] = []
    for (let at = 0; at < count; at++) found.push({ start: positions[at * 2], end: positions[at * 2 + 1] })
    return { snippet: storedText(snippet, 0, length[0]), positions: found }
  }
}
