import { encodeJson } from '../json-encoding'
import type { TaskRecord } from '../server/types'
import type {
  ManualQuerySuggestion,
  QuerySuggestionsPreview,
  QuerySuggestionsSetting,
  QuerySuggestionsStatus,
  RecordQueryResult,
} from '../types/query-suggestions'
import type { Transport } from './http'
import type { RequestOptions } from './options'
import { indexPath } from './paths'
import { readArray, readBody, readNumber, readString } from './response-shape'

/**
 * These methods count searches and manage the popular query suggestions of an
 * index on a server, as `querySuggestions(engine)` does on an engine.
 *
 * @public
 */
export interface QuerySuggestionOperations {
  /**
   * Replaces the popular query suggestions setting of an index. Turning the
   * feature off deletes the search history of the index on the server and
   * keeps its suggestions indexes.
   *
   * @param indexName - The server replaces the setting of this index.
   * @param setting - This is the new setting, whose omitted limits take their defaults.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @throws A `NarsilError` with `CONFIG_INVALID` when the setting breaks a
   * limit, names a field the schema lacks, or turns the feature on for an index
   * with device sync on or for a server without a key.
   */
  updateQuerySuggestions(indexName: string, setting: QuerySuggestionsSetting, options?: RequestOptions): Promise<void>
  /**
   * Reads the setting, the last build, the next scheduled build, and the
   * suggestions indexes of an index.
   *
   * @param indexName - The server reports on this index.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The status of the index.
   */
  querySuggestionsStatus(indexName: string, options?: RequestOptions): Promise<QuerySuggestionsStatus>
  /**
   * Counts one search that a person followed with a click. The server takes
   * the person and the group from its `identify` function, so this request
   * carries the search alone.
   *
   * @param indexName - The index that the person searched.
   * @param query - The search, which the server normalises before it counts it.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request, such as the credentials that `identify` reads.
   * @returns Whether the server counted the search, and why not where it didn't.
   * @throws A `NarsilError` with `QUERY_SUGGESTIONS_NOT_ENABLED` when the index
   * has the feature off or the server has no `identify` function.
   */
  recordQuery(indexName: string, query: string, options?: RequestOptions): Promise<RecordQueryResult>
  /**
   * Starts a build of the suggestions of an index. Follow the returned record
   * with {@link TaskOperations.waitForTask}, whose `build` field reports the
   * build once it ends.
   *
   * @param indexName - The server builds the suggestions of this index.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The record of the task that runs the build.
   */
  buildQuerySuggestions(indexName: string, options?: RequestOptions): Promise<TaskRecord>
  /**
   * Lists the phrases that enough people searched for, before the result
   * checks of a build run.
   *
   * @param indexName - The source index.
   * @param limit - The most phrases to list, from 1 to 1,000. Defaults to 100.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The phrases, most counted first.
   */
  previewQuerySuggestions(indexName: string, limit?: number, options?: RequestOptions): Promise<QuerySuggestionsPreview>
  /**
   * Reads the ban list of an index.
   *
   * @param indexName - The source index.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The banned phrases in their normal form.
   */
  readQueryBans(indexName: string, options?: RequestOptions): Promise<string[]>
  /**
   * Replaces the ban list of an index, and removes each newly banned phrase
   * from every suggestions index of the index before it answers.
   *
   * @param indexName - The source index.
   * @param bans - At most 1,000 phrases, which the server normalises.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The stored ban list.
   */
  replaceQueryBans(indexName: string, bans: string[], options?: RequestOptions): Promise<string[]>
  /**
   * Bans a phrase and removes it from every suggestions index of an index.
   *
   * @param indexName - The source index.
   * @param query - The phrase, which the server normalises.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The number of suggestions indexes that held the phrase.
   */
  removeQuery(indexName: string, query: string, options?: RequestOptions): Promise<number>
  /**
   * Adds a suggestion by hand, which a build leaves in place.
   *
   * @param indexName - The source index.
   * @param suggestion - The group, the phrase, and its count.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The name of the suggestions index that holds the phrase.
   */
  addManualSuggestion(indexName: string, suggestion: ManualQuerySuggestion, options?: RequestOptions): Promise<string>
}

export function createQuerySuggestionOperations(transport: Transport): QuerySuggestionOperations {
  const pathOf = (indexName: string, route = ''): string => `${indexPath(indexName)}/query-suggestions${route}`

  function send(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: unknown,
    options: RequestOptions | undefined,
  ): Promise<unknown> {
    return transport.json({
      method,
      path,
      ...(body === undefined ? {} : { body: encodeJson(body), contentType: 'application/json' }),
      options,
    })
  }

  return {
    async updateQuerySuggestions(indexName, setting, options) {
      await send('PUT', pathOf(indexName), setting, options)
    },
    async querySuggestionsStatus(indexName, options) {
      const path = pathOf(indexName)
      return readBody<QuerySuggestionsStatus>(await send('GET', path, undefined, options), path)
    },
    async recordQuery(indexName, query, options) {
      const path = pathOf(indexName, '/record')
      return readBody<RecordQueryResult>(await send('POST', path, { query }, options), path)
    },
    async buildQuerySuggestions(indexName, options) {
      const path = pathOf(indexName, '/build')
      return readBody<TaskRecord>(await send('POST', path, undefined, options), path)
    },
    async previewQuerySuggestions(indexName, limit, options) {
      const path = pathOf(indexName, '/preview')
      const payload = await transport.json({
        method: 'GET',
        path,
        ...(limit === undefined ? {} : { query: { limit: String(limit) } }),
        options,
      })
      return readBody<QuerySuggestionsPreview>(payload, path)
    },
    async readQueryBans(indexName, options) {
      const path = pathOf(indexName, '/bans')
      return readArray<string>(await send('GET', path, undefined, options), 'bans', path)
    },
    async replaceQueryBans(indexName, bans, options) {
      const path = pathOf(indexName, '/bans')
      return readArray<string>(await send('PUT', path, { bans }, options), 'bans', path)
    },
    async removeQuery(indexName, query, options) {
      const path = pathOf(indexName, '/remove')
      return readNumber(await send('POST', path, { query }, options), 'suggestionIndexes', path)
    },
    async addManualSuggestion(indexName, suggestion, options) {
      const path = pathOf(indexName, '/manual')
      return readString(await send('POST', path, suggestion, options), 'indexName', path)
    },
  }
}
