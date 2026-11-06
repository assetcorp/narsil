/**
 * The body of `POST /indexes/{name}/query-suggestions/record`. The server
 * takes the person and the group from its `identify` function, so the body
 * carries the search alone.
 *
 * @public
 */
export interface RecordQueryBody {
  /** The search that the person followed with a click. */
  query: string
}

/**
 * The query string of `GET /indexes/{name}/query-suggestions/preview`.
 *
 * @public
 */
export interface QuerySuggestionsPreviewQuery {
  /** The most phrases to list, from 1 to 1,000, and 100 by default. */
  limit?: number
}

/**
 * The body of `GET` and of `PUT /indexes/{name}/query-suggestions/bans`.
 *
 * @public
 */
export interface QueryBansBody {
  /** The banned phrases, at most 1,000, which the engine normalises. */
  bans: string[]
}

/**
 * The body of `POST /indexes/{name}/query-suggestions/remove`.
 *
 * @public
 */
export interface RemoveQueryBody {
  /** The phrase to ban and to remove from every suggestions index of the index. */
  query: string
}

/**
 * The answer of `POST /indexes/{name}/query-suggestions/remove`.
 *
 * @public
 */
export interface RemoveQueryResponse {
  /** The number of suggestions indexes that held the phrase. */
  suggestionIndexes: number
}

/**
 * The answer of `POST /indexes/{name}/query-suggestions/manual`.
 *
 * @public
 */
export interface ManualSuggestionResponse {
  /** The suggestions index that holds the phrase. */
  indexName: string
}

/**
 * The query string of `GET /indexes/{name}/snapshot`.
 *
 * @public
 */
export interface SnapshotQuery {
  /** Under `true`, the archive also holds the index's search history. */
  queryHistory?: 'true' | 'false'
}
