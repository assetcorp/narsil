import {
  acceptedPhrase,
  banListFromInput,
  DEFAULT_PREVIEW_LIMIT,
  ErrorCodes,
  GROUP_FORMAT,
  invalidSetting,
  isGroup,
  MAX_MANUAL_SUGGESTION_COUNT,
  MAX_PREVIEW_LIMIT,
  MAX_SOURCE_INDEX_NAME_LENGTH,
  NarsilError,
  normaliseBan,
  requireFieldsInSchema,
  resolveSetting,
  unionOfBans,
  validateSetting,
  withState,
} from '#platform/suggestions-host'
import type {
  ManualQuerySuggestion,
  QuerySuggestions,
  QuerySuggestionsPreview,
  QuerySuggestionsSetting,
  QuerySuggestionsStatus,
} from '../types/query-suggestions'
import type { IndexView } from './host'
import { previewBuild } from './preview'
import type { QuerySuggestionsRuntime } from './runtime'
import {
  ensureSuggestionsIndex,
  markedSuggestionIndexes,
  ORIGIN_MANUAL,
  removeSuggestions,
  suggestionDocument,
  suggestionsIndexName,
} from './suggestions-writer'

function requireView(runtime: QuerySuggestionsRuntime, indexName: string): IndexView {
  const view = runtime.host.view(indexName)
  if (view === null) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" does not exist`, { indexName })
  }
  return view
}

function requireSourceView(runtime: QuerySuggestionsRuntime, indexName: string): IndexView {
  const view = requireView(runtime, indexName)
  if (view.state?.querySuggestionsSource !== undefined) {
    invalidSetting(`Index "${indexName}" is a suggestions index, so it takes no query suggestions of its own`, {
      indexName,
    })
  }
  if (indexName.length > MAX_SOURCE_INDEX_NAME_LENGTH) {
    invalidSetting(
      `Index "${indexName}" has a name longer than ${MAX_SOURCE_INDEX_NAME_LENGTH} characters, which leaves no room for the names of its suggestions indexes`,
      { indexName },
    )
  }
  return view
}

function requireAcceptable(runtime: QuerySuggestionsRuntime, indexName: string, setting: QuerySuggestionsSetting) {
  const view = requireSourceView(runtime, indexName)
  requireFieldsInSchema(setting, view.schema)
  if (!setting.enabled) return
  if (runtime.scrambler === null) {
    invalidSetting('This engine has no query suggestions key, so it cannot turn the feature on', { indexName })
  }
  if (view.hasSync) {
    invalidSetting(
      `Index "${indexName}" has device sync on, and a device receives the whole index of one user while a suggestion comes from the searches of several people`,
      { indexName },
    )
  }
}

async function updateSetting(runtime: QuerySuggestionsRuntime, indexName: string, raw: unknown): Promise<void> {
  const setting = validateSetting(raw)
  requireAcceptable(runtime, indexName, setting)
  await runtime.host.updateState(indexName, current => {
    requireAcceptable(runtime, indexName, setting)
    return withState(current, { querySuggestions: setting })
  })
  if (!setting.enabled) await runtime.discardHistory(indexName)
  runtime.settingChanged(indexName)
}

async function status(runtime: QuerySuggestionsRuntime, indexName: string): Promise<QuerySuggestionsStatus> {
  const view = requireView(runtime, indexName)
  return {
    indexName,
    setting: view.state?.querySuggestions ?? null,
    lastBuild: await runtime.builds.lastBuild(indexName),
    nextBuildAt: runtime.timers.nextBuildAt(indexName),
    suggestionIndexes: [...markedSuggestionIndexes(runtime.host, indexName).values()].sort(),
  }
}

function previewLimitOf(limit: unknown): number {
  if (limit === undefined) return DEFAULT_PREVIEW_LIMIT
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PREVIEW_LIMIT) {
    invalidSetting(`The preview limit must be a whole number from 1 to ${MAX_PREVIEW_LIMIT}`)
  }
  return limit
}

async function preview(
  runtime: QuerySuggestionsRuntime,
  indexName: string,
  limit: unknown,
): Promise<QuerySuggestionsPreview> {
  const max = previewLimitOf(limit)
  runtime.enabledSetting(indexName)
  const scrambler = runtime.scrambler
  if (scrambler === null) invalidSetting('This engine has no query suggestions key, so it holds no counts')
  const context = {
    host: runtime.host,
    scrambler,
    saveDay: (name: string) => runtime.saveDay(name),
    withWriteLock: <T>(name: string, work: () => Promise<T>) => runtime.withWriteLock(name, work),
    isStopping: () => runtime.isStopping,
  }
  return previewBuild(context, indexName, max)
}

async function banPhrases(
  runtime: QuerySuggestionsRuntime,
  indexName: string,
  next: (current: readonly string[]) => string[],
): Promise<{ stored: string[]; added: string[] }> {
  requireSourceView(runtime, indexName)
  let added: string[] = []
  let stored: string[] = []
  await runtime.host.updateState(indexName, current => {
    requireSourceView(runtime, indexName)
    const previous = current?.bannedQueries ?? []
    stored = next(previous)
    const before = new Set(previous)
    added = stored.filter(phrase => !before.has(phrase))
    return withState(current, { bannedQueries: stored })
  })
  return { stored, added }
}

async function removeFromSuggestions(
  runtime: QuerySuggestionsRuntime,
  indexName: string,
  phrases: readonly string[],
): Promise<number> {
  let holders = 0
  if (phrases.length === 0) return holders
  for (const name of markedSuggestionIndexes(runtime.host, indexName).values()) {
    if ((await removeSuggestions(runtime.host, name, phrases)) > 0) holders += 1
  }
  return holders
}

function updateBans(runtime: QuerySuggestionsRuntime, indexName: string, raw: unknown): Promise<string[]> {
  const phrases = banListFromInput(raw)
  return runtime.withWriteLock(indexName, async () => {
    const { stored, added } = await banPhrases(runtime, indexName, () => phrases)
    await removeFromSuggestions(runtime, indexName, added)
    return stored
  })
}

function removeQuery(runtime: QuerySuggestionsRuntime, indexName: string, raw: unknown): Promise<number> {
  const phrase = normaliseBan(raw)
  return runtime.withWriteLock(indexName, async () => {
    await banPhrases(runtime, indexName, current => unionOfBans(current, [phrase]))
    return removeFromSuggestions(runtime, indexName, [phrase])
  })
}

function manualCountOf(count: unknown): number {
  if (count === undefined) return 0
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > MAX_MANUAL_SUGGESTION_COUNT) {
    invalidSetting(`A suggestion's count must be a whole number from 0 to ${MAX_MANUAL_SUGGESTION_COUNT}`)
  }
  return count
}

function addSuggestion(runtime: QuerySuggestionsRuntime, indexName: string, raw: unknown): Promise<string> {
  const { group, query, count } = (raw ?? {}) as Partial<ManualQuerySuggestion>
  if (!isGroup(group)) invalidSetting(`A suggestion needs a group of ${GROUP_FORMAT}`)
  if (typeof query !== 'string') invalidSetting('A suggestion needs its query as a string')
  const documentCount = manualCountOf(count)
  return runtime.withWriteLock(indexName, async () => {
    const view = requireSourceView(runtime, indexName)
    const setting = resolveSetting(view.state?.querySuggestions ?? { enabled: false, fields: [] })
    const phrase = acceptedPhrase(query, setting)
    if (phrase === null) invalidSetting('The suggestion is not a phrase that the setting of the index accepts')
    if ((view.state?.bannedQueries ?? []).includes(phrase)) {
      invalidSetting('The ban list of the index holds this phrase', { indexName })
    }
    const marked = markedSuggestionIndexes(runtime.host, indexName)
    if (!marked.has(group) && marked.size >= setting.maxGroups) {
      invalidSetting(`Index "${indexName}" already has ${setting.maxGroups} groups`, { indexName })
    }
    const name = await ensureSuggestionsIndex(runtime.host, indexName, group)
    const document = suggestionDocument(phrase, documentCount, ORIGIN_MANUAL)
    if (await runtime.host.engine.has(name, phrase)) await runtime.host.engine.update(name, phrase, document)
    else await runtime.host.engine.insert(name, document)
    return name
  })
}

export function querySuggestionsOf(runtime: () => Promise<QuerySuggestionsRuntime>): QuerySuggestions {
  return {
    recordQuery: async (indexName, query) => (await runtime()).record(indexName, query),
    updateSetting: async (indexName, setting) => updateSetting(await runtime(), indexName, setting),
    status: async indexName => status(await runtime(), indexName),
    build: async indexName => (await runtime()).builds.start(indexName, 'caller'),
    preview: async (indexName, limit) => preview(await runtime(), indexName, limit),
    bans: async indexName => [...(requireView(await runtime(), indexName).state?.bannedQueries ?? [])],
    updateBans: async (indexName, phrases) => updateBans(await runtime(), indexName, phrases),
    removeQuery: async (indexName, query) => removeQuery(await runtime(), indexName, query),
    addSuggestion: async (indexName, suggestion) => addSuggestion(await runtime(), indexName, suggestion),
    suggestionsIndexName: (indexName, group) => {
      if (!isGroup(group)) invalidSetting(`A group holds ${GROUP_FORMAT}`)
      return suggestionsIndexName(indexName, group)
    },
  }
}
