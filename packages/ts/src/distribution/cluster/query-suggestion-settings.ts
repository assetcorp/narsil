import { decode, encode } from '@msgpack/msgpack'
import type { ConfigFieldRejection } from '../../engine/snapshot/restore-config'
import { NarsilError } from '../../errors'
import { getLanguage } from '../../languages/registry'
import { storedStateOf } from '../../query-suggestions/stored-state'
import type { StoredQuerySuggestions } from '../../types/internal'
import type { QuerySuggestionsSetting, QuerySuggestionsSource } from '../../types/query-suggestions'
import type { IndexMetadataSnapshot } from './index-metadata'
import { isRecord } from './index-settings'

export interface ClusterQuerySuggestionSettings {
  querySuggestions?: QuerySuggestionsSetting
  bannedQueries?: string[]
  querySuggestionsSource?: QuerySuggestionsSource
}

export function decodeClusterQuerySuggestionSettings(
  raw: Record<string, unknown>,
  reject: ConfigFieldRejection,
): ClusterQuerySuggestionSettings {
  let state: StoredQuerySuggestions | null
  try {
    state = storedStateOf({
      querySuggestions: raw.querySuggestions,
      bannedQueries: raw.bannedQueries,
      querySuggestionsSource: raw.querySuggestionsSource,
    })
  } catch (error) {
    return reject(error instanceof NarsilError ? error.message : 'the query suggestion settings are malformed')
  }
  return state ?? {}
}

export function suggestionStateOfSettings(
  settings: ClusterQuerySuggestionSettings | undefined,
): StoredQuerySuggestions | null {
  if (settings === undefined) return null
  const state: StoredQuerySuggestions = {
    ...(settings.querySuggestions !== undefined ? { querySuggestions: settings.querySuggestions } : {}),
    ...(settings.bannedQueries !== undefined ? { bannedQueries: settings.bannedQueries } : {}),
    ...(settings.querySuggestionsSource !== undefined
      ? { querySuggestionsSource: settings.querySuggestionsSource }
      : {}),
  }
  return Object.keys(state).length === 0 ? null : state
}

export function metadataWithSuggestionState(
  snapshot: IndexMetadataSnapshot,
  state: StoredQuerySuggestions | null,
): Uint8Array {
  const decoded = decode(snapshot.bytes)
  const fields = isRecord(decoded) ? decoded : {}
  const {
    querySuggestions: _setting,
    bannedQueries: _banned,
    ...settings
  } = isRecord(fields.settings)
    ? fields.settings
    : { language: snapshot.settings?.language ?? getLanguage('english').name }
  const next = {
    ...settings,
    ...(state?.querySuggestions !== undefined ? { querySuggestions: state.querySuggestions } : {}),
    ...(state?.bannedQueries !== undefined && state.bannedQueries.length > 0
      ? { bannedQueries: state.bannedQueries }
      : {}),
  }
  return new Uint8Array(encode({ ...fields, settings: next }, { ignoreUndefined: true }))
}
