import { importOptionalReads } from '../../engine/optional-reads-code'
import { lazyCode } from '../../search/lazy-code'
import type * as Suggestions from './suggestion-runtime'

const code = lazyCode('term suggestions', importOptionalReads)

export const loadSuggestions = code.load

export function loadPrefixFor(prefix: boolean | null | undefined): Promise<void> | null {
  return prefix === true ? code.load() : null
}

export const expandTermPrefix: typeof Suggestions.expandTermPrefix = (...args) => code.get().expandTermPrefix(...args)

export const suggestDisplayTerms: typeof Suggestions.suggestDisplayTerms = (...args) =>
  code.get().suggestDisplayTerms(...args)

export const compositeSuggestTerms: typeof Suggestions.compositeSuggestTerms = (...args) =>
  code.get().compositeSuggestTerms(...args)
