/**
 * The popular query suggestions setting of one index. Only `enabled` and
 * `fields` are required, and each limit that you leave out takes its default.
 *
 * @public
 */
export interface QuerySuggestionsSetting {
  /** Set this to true to count searches for the index and build its suggestions. */
  enabled: boolean
  /** The `string` and `string[]` fields whose text a phrase must match before the engine publishes it. */
  fields: string[]
  /** The number of people, from 2 to 4,096, who must search a phrase before the engine publishes it. Defaults to 4. */
  minPeople?: number
  /** The number of documents, from 1 to 10,000, that a phrase must match with every word. Defaults to 5. */
  minResults?: number
  /** The number of days, from 1 to 365, that the engine keeps the counts of a day. Defaults to 30. */
  retentionDays?: number
  /** The number of phrases, up to 16,384, that a node counts for the index each day. Defaults to 10,000. */
  maxPhrasesPerDay?: number
  /** The number of phrases, up to 1,000, that a node counts for one person each day. Defaults to 100. */
  maxPhrasesPerPerson?: number
  /** The number of people, up to 100,000, that a node counts for the index each day. Defaults to 100,000. */
  maxPeoplePerDay?: number
  /** The number of groups, up to 1,000, that the index counts. Defaults to 100. */
  maxGroups?: number
  /** The number of letters that a phrase must hold. Defaults to 4. */
  minLetters?: number
  /** The number of characters, up to 150, that a phrase may hold. Defaults to 100. */
  maxLength?: number
  /** The number of words, up to 50, that a phrase may hold. Defaults to 8. */
  maxWords?: number
  /** The number of digits that a phrase may hold in total. Defaults to 5. */
  maxDigits?: number
  /** The number of phrases, up to 500,000, that one build merges. Defaults to 100,000. */
  maxMergePhrases?: number
  /** The memory, from 16 MiB to 1 GiB, of the worker that merges the counts. Defaults to 128 MiB. */
  mergeMemoryBytes?: number
  /** How often, from 1 second to 1 hour, a node saves the counts of the day. Defaults to 5 minutes. */
  saveIntervalMs?: number
  /** The number of result checks, up to 1,000, that a build runs each second. Defaults to 20. */
  resultChecksPerSecond?: number
  /** A cron expression of five fields, or `off`. Defaults to `0 3 * * *`. */
  schedule?: string
  /** The IANA time zone of `schedule`. Defaults to `UTC`. */
  timeZone?: string
}

/**
 * The marker that the engine gives each suggestions index: the index whose
 * searches it holds, and the group that it serves.
 *
 * @public
 */
export interface QuerySuggestionsSource {
  /** The index whose searches the suggestions come from. */
  index: string
  /** The group whose searches the suggestions come from. */
  group: string
}

/**
 * Why a node counted no search, or `recorded` where it counted one.
 *
 * @public
 */
export type RecordQueryOutcome =
  | 'recorded'
  | 'repeat'
  | 'invalid'
  | 'banned'
  | 'person-limit'
  | 'phrase-limit'
  | 'people-limit'
  | 'group-limit'
  | 'no-key'
  | 'unidentified'

/**
 * What {@link QuerySuggestions.recordQuery} did with one search.
 *
 * @public
 */
export interface RecordQueryResult {
  /** True where the node counted the search. */
  recorded: boolean
  /** Why the node counted it or left it out. */
  outcome: RecordQueryOutcome
}

/**
 * What started a build.
 *
 * @public
 */
export type QuerySuggestionsBuildTrigger = 'schedule' | 'missed' | 'caller'

/**
 * The outcome of a build.
 *
 * @public
 */
export type QuerySuggestionsBuildStatus = 'running' | 'completed' | 'failed' | 'skipped'

/**
 * One build of the suggestions of an index.
 *
 * @public
 */
export interface QuerySuggestionsBuild {
  /** The ID of the build. */
  buildId: string
  /** What started the build. */
  trigger: QuerySuggestionsBuildTrigger
  /** Where the build stands. */
  status: QuerySuggestionsBuildStatus
  /** When the build started, in milliseconds since the Unix epoch. */
  startedAt: number
  /** When the build ended, or null while it runs. */
  endedAt: number | null
  /** The phrases that the build added or updated. */
  published: number
  /** The phrases that the build removed. */
  removed: number
  /** The phrases that the build left out because the merge held its limit. */
  discarded: number
  /** The error code of a failed build, or null. */
  errorCode: string | null
}

/**
 * The setting, the last build, and the next scheduled build of one index.
 *
 * @public
 */
export interface QuerySuggestionsStatus {
  /** The index. */
  indexName: string
  /** The setting, or null where nobody set one. */
  setting: QuerySuggestionsSetting | null
  /** The last build, or null where none ran. */
  lastBuild: QuerySuggestionsBuild | null
  /** When the schedule next matches, in milliseconds since the Unix epoch, or null where it is off. */
  nextBuildAt: number | null
  /** The suggestions index of each group that holds one. */
  suggestionIndexes: string[]
}

/**
 * One phrase that a build would publish.
 *
 * @public
 */
export interface QuerySuggestionPreviewEntry {
  /** The group whose suggestions index would hold the phrase. */
  group: string
  /** The normalised phrase. */
  query: string
  /** The number of people whose searches the counts hold. */
  count: number
}

/**
 * What the next build would publish: the phrases that enough people searched
 * for, that match enough documents, and that fall in a group the build keeps.
 *
 * @public
 */
export interface QuerySuggestionsPreview {
  /** The phrases, most counted first. */
  entries: QuerySuggestionPreviewEntry[]
  /** True where the list stops at the limit that the caller passed while more phrases wait to be checked. */
  truncated: boolean
}

/**
 * A suggestion that a caller adds by hand.
 *
 * @public
 */
export interface ManualQuerySuggestion {
  /** The group whose suggestions index takes the phrase. */
  group: string
  /** The phrase, which the engine normalises. */
  query: string
  /** The count that ranks the phrase. Defaults to 0. */
  count?: number
}

/**
 * The events of popular query suggestions. No event carries search text.
 *
 * @public
 */
export interface QuerySuggestionsBuildEvent {
  /** The source index. */
  indexName: string
  /** The ID of the build. */
  buildId: string
  /** `started`, `completed`, `failed`, or `skipped`. */
  phase: 'started' | 'completed' | 'failed' | 'skipped'
  /** What started the build. */
  trigger: QuerySuggestionsBuildTrigger
  /** The phrases that the build added or updated. */
  published: number
  /** The phrases that the build removed. */
  removed: number
  /** The phrases that the build left out. */
  discarded: number
  /** The error code of a failed build. */
  errorCode?: string
}

/**
 * Why the engine warns about popular query suggestions.
 *
 * @public
 */
export type QuerySuggestionsWarningReason =
  | 'save-failed'
  | 'damaged-file'
  | 'other-key'
  | 'no-key'
  | 'phrase-limit'
  | 'people-limit'
  | 'ban-removal-failed'

/**
 * A warning about popular query suggestions, which carries no search text.
 *
 * @public
 */
export interface QuerySuggestionsWarningEvent {
  /** The source index. */
  indexName: string
  /** What happened. */
  reason: QuerySuggestionsWarningReason
  /** The history file that the warning concerns, where there is one. */
  file?: string
  /** The error message of a failed save. */
  message?: string
}

/**
 * One search that a person followed with a click.
 *
 * @public
 */
export interface RecordedQuery {
  /** The search text, which the engine normalises before it counts it. */
  query: string
  /** The ID of the person who searched, from 1 to 256 UTF-16 code units. The engine scrambles it with the key. */
  person: string
  /** The audience whose suggestions the search counts towards, from 1 to 32 letters, digits, `_`, and `-`. */
  group: string
}

/**
 * Popular query suggestions for one engine, which
 * `querySuggestions(engine)` from `@delali/narsil/query-suggestions` returns.
 *
 * @public
 */
export interface QuerySuggestions {
  /**
   * Counts one search that a person followed with a click.
   *
   * @param indexName - The index that the person searched.
   * @param query - The search, the person, and the group.
   * @returns Whether the engine counted the search, and why not where it didn't.
   */
  recordQuery(indexName: string, query: RecordedQuery): Promise<RecordQueryResult>
  /**
   * Replaces the setting of an index. Turning the feature off deletes the
   * index's search history and keeps its suggestions indexes.
   *
   * @param indexName - The index whose searches the engine counts.
   * @param setting - The setting, whose omitted limits take their defaults.
   */
  updateSetting(indexName: string, setting: QuerySuggestionsSetting): Promise<void>
  /**
   * Reports the setting, the last build, and the next scheduled build.
   *
   * @param indexName - The source index.
   * @returns The status of the index.
   */
  status(indexName: string): Promise<QuerySuggestionsStatus>
  /**
   * Builds the suggestions of an index now. A build that finds another build
   * of the index under way reports `skipped`.
   *
   * @param indexName - The source index.
   * @returns The build once it ends.
   */
  build(indexName: string): Promise<QuerySuggestionsBuild>
  /**
   * Lists what the next build would publish. The preview runs the same
   * result checks as a build, at the same `resultChecksPerSecond`, until it
   * holds `limit` phrases.
   *
   * @param indexName - The source index.
   * @param limit - The most phrases to list, from 1 to 1,000. Defaults to 100.
   * @returns The phrases, most counted first.
   */
  preview(indexName: string, limit?: number): Promise<QuerySuggestionsPreview>
  /**
   * Returns the ban list of an index.
   *
   * @param indexName - The source index.
   * @returns The banned phrases in their normal form.
   */
  bans(indexName: string): Promise<string[]>
  /**
   * Replaces the ban list, and removes each newly banned phrase from every
   * suggestions index of the index before it returns.
   *
   * @param indexName - The source index.
   * @param phrases - At most 1,000 phrases, which the engine normalises.
   * @returns The stored ban list.
   */
  updateBans(indexName: string, phrases: string[]): Promise<string[]>
  /**
   * Bans a phrase and removes it from every suggestions index of the index.
   *
   * @param indexName - The source index.
   * @param query - The phrase, which the engine normalises.
   * @returns The number of suggestions indexes that held the phrase.
   */
  removeQuery(indexName: string, query: string): Promise<number>
  /**
   * Adds a suggestion by hand, with `origin` set to `manual`, which a build
   * leaves in place.
   *
   * @param indexName - The source index.
   * @param suggestion - The group, the phrase, and its count.
   * @returns The name of the suggestions index that holds it.
   */
  addSuggestion(indexName: string, suggestion: ManualQuerySuggestion): Promise<string>
  /**
   * Returns the name of the suggestions index of a group, which an app
   * queries with `{ term, prefix: true, termMatch: 'all', sort: { count: 'desc' } }`.
   *
   * @param indexName - The source index.
   * @param group - The group.
   * @returns The name of the suggestions index.
   */
  suggestionsIndexName(indexName: string, group: string): string
}
