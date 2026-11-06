import type { StoredQuerySuggestions } from '../types/internal'
import { storedBanList } from './bans'
import { settingFromWire, settingToWire, validateSetting, validateSource } from './setting'

export interface StoredStateFields {
  querySuggestions?: unknown
  bannedQueries?: unknown
  querySuggestionsSource?: unknown
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null
}

export function storedStateOf(raw: StoredStateFields): StoredQuerySuggestions | null {
  const state: StoredQuerySuggestions = {}
  if (isPresent(raw.querySuggestions)) state.querySuggestions = validateSetting(raw.querySuggestions)
  if (isPresent(raw.bannedQueries)) {
    const banned = storedBanList(raw.bannedQueries)
    if (banned.length > 0) state.bannedQueries = banned
  }
  if (isPresent(raw.querySuggestionsSource)) state.querySuggestionsSource = validateSource(raw.querySuggestionsSource)
  return Object.keys(state).length === 0 ? null : state
}

export function storedStateToWire(state: StoredQuerySuggestions): Record<string, unknown> {
  const wire: Record<string, unknown> = {}
  if (state.querySuggestions !== undefined) wire.query_suggestions = settingToWire(state.querySuggestions)
  if (state.bannedQueries !== undefined) wire.banned_queries = [...state.bannedQueries]
  if (state.querySuggestionsSource !== undefined) {
    wire.query_suggestions_source = {
      index: state.querySuggestionsSource.index,
      group: state.querySuggestionsSource.group,
    }
  }
  return wire
}

export interface StoredStateWire {
  query_suggestions?: unknown
  banned_queries?: unknown
  query_suggestions_source?: unknown
}

export function storedStateFromWire(raw: StoredStateWire): StoredQuerySuggestions | null {
  const state = storedStateOf({
    bannedQueries: raw.banned_queries,
    querySuggestionsSource: raw.query_suggestions_source,
  })
  if (!isPresent(raw.query_suggestions)) return state
  return { ...state, querySuggestions: settingFromWire(raw.query_suggestions) }
}

export function withState(
  current: StoredQuerySuggestions | null,
  change: Partial<StoredQuerySuggestions>,
): StoredQuerySuggestions | null {
  const next: StoredQuerySuggestions = { ...current, ...change }
  for (const key of Object.keys(next) as (keyof StoredQuerySuggestions)[]) {
    const value = next[key]
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete next[key]
  }
  return Object.keys(next).length === 0 ? null : next
}
