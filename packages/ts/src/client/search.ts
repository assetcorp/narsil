import type { PreflightResult, QueryResult, SuggestResult } from '../types/results'
import type { AnyDocument } from '../types/schema'
import type { QueryParams, SuggestParams } from '../types/search'
import type { Transport } from './http'
import type { RequestOptions } from './options'
import { indexPath } from './paths'
import { readBody } from './response-shape'

/**
 * Searching an index over HTTP.
 *
 * Each method has the name of the {@link Narsil} method it mirrors, and takes
 * the same parameters, so a query written against an embedded engine runs
 * against a server unchanged.
 *
 * @public
 */
export interface SearchOperations {
  /**
   * Runs a search and returns the ranked hits.
   *
   * The parameters hold the text, the filters, the sort, the facets, the
   * grouping, and the vector or hybrid settings, exactly as the engine takes
   * them. For a vector search that names `text` instead of a vector, the server
   * must hold the embedding adapter the index was created with.
   *
   * @typeParam T - Shape of the stored documents, which flows through to each
   * hit's `document`.
   * @param indexName - The index to search.
   * @param params - Everything the search asks for.
   * @param options - Per-call signal, deadline, and headers.
   * @returns The hits, the total match count, and whatever the query asked for
   * alongside them.
   * @throws A `NarsilError` with `SEARCH_RESULT_WINDOW_EXCEEDED` when `offset`
   * plus `limit` passes the server's result window, which the cursor pages
   * beyond.
   */
  query<T = AnyDocument>(indexName: string, params: QueryParams, options?: RequestOptions): Promise<QueryResult<T>>
  /**
   * Counts what a search would match, without building or ranking a single hit,
   * which is enough to show a result count beside a filter.
   *
   * @param indexName - The index to count in.
   * @param params - The same parameters {@link SearchOperations.query} takes.
   * @param options - Per-call signal, deadline, and headers.
   * @returns The match count and how long it took.
   */
  preflight(indexName: string, params: QueryParams, options?: RequestOptions): Promise<PreflightResult>
  /**
   * Completes a prefix from the terms the index holds, ready to offer as
   * you-type suggestions.
   *
   * @param indexName - The index to complete from.
   * @param params - The prefix, the field, and how many completions to return.
   * @param options - Per-call signal, deadline, and headers.
   * @returns The completions, most widely used first.
   */
  suggest(indexName: string, params: SuggestParams, options?: RequestOptions): Promise<SuggestResult>
}

export function createSearchOperations(transport: Transport): SearchOperations {
  async function post<T>(path: string, params: unknown, options: RequestOptions | undefined): Promise<T> {
    const payload = await transport.json({
      method: 'POST',
      path,
      body: JSON.stringify(params),
      contentType: 'application/json',
      options,
    })
    return readBody<T>(payload, path)
  }

  return {
    query<T = AnyDocument>(indexName: string, params: QueryParams, options?: RequestOptions) {
      return post<QueryResult<T>>(`${indexPath(indexName)}/search`, params, options)
    },
    preflight(indexName, params, options) {
      return post<PreflightResult>(`${indexPath(indexName)}/search/preflight`, params, options)
    },
    suggest(indexName, params, options) {
      return post<SuggestResult>(`${indexPath(indexName)}/suggest`, params, options)
    },
  }
}
