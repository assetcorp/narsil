import type { QuerySuggestions } from '../types/query-suggestions'

const providers = new WeakMap<object, () => QuerySuggestions>()

export function bindQuerySuggestions(owner: object, provide: () => QuerySuggestions): void {
  providers.set(owner, provide)
}

export function boundQuerySuggestionsOf(owner: object): (() => QuerySuggestions) | undefined {
  return providers.get(owner)
}
