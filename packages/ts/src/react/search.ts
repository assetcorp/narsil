import type { PreflightResult, QueryResult, SuggestResult } from '../types/results'
import type { AnyDocument } from '../types/schema'
import type { QueryParams, SuggestParams } from '../types/search'
import type { NarsilReadOptions, NarsilReadState } from './options'
import { useRead } from './read'

/**
 * Searches an index and re-runs the search whenever the parameters change.
 *
 * The parameters are the ones {@link SearchOperations.query} takes, and the
 * answer is the same `QueryResult`. Set `keepPreviousData` for a
 * search-as-you-type box, so that the hits already on screen stay there while
 * the next answer loads.
 *
 * @typeParam T - This is the shape of the stored documents, which flows through
 * to each hit's `document`.
 * @param indexName - This names the index to search.
 * @param params - These carry the text, the filters, the sort, and everything
 * else the search asks for.
 * @param options - These switch the hook off, keep the last answer on screen,
 * and set the refresh interval, the headers, and the deadline.
 * @returns The state holds the result, the failure, the loading flags, and the
 * way to search again.
 *
 * @public
 */
export function useQuery<T = AnyDocument>(
  indexName: string,
  params: QueryParams,
  options?: NarsilReadOptions,
): NarsilReadState<QueryResult<T>> {
  return useRead(
    ['query', indexName, params],
    (client, request) => client.query<T>(indexName, params, request),
    options,
  )
}

/**
 * Counts what a search would match, without building or ranking a single hit,
 * which is what a result count beside a filter reads.
 *
 * @param indexName - This names the index to count in.
 * @param params - These are the parameters {@link useQuery} takes.
 * @param options - These switch the hook off, keep the last answer, and set the
 * refresh interval, the headers, and the deadline.
 * @returns The state holds the match count and how long the count took.
 *
 * @public
 */
export function usePreflight(
  indexName: string,
  params: QueryParams,
  options?: NarsilReadOptions,
): NarsilReadState<PreflightResult> {
  return useRead(
    ['preflight', indexName, params],
    (client, request) => client.preflight(indexName, params, request),
    options,
  )
}

/**
 * Completes a prefix from the terms an index holds, ready to offer under a
 * search box.
 *
 * @param indexName - This names the index to complete from.
 * @param params - These set the prefix and how many completions come back.
 * @param options - These switch the hook off, keep the last completions on
 * screen, and set the refresh interval, the headers, and the deadline.
 * @returns The state holds the completions, most widely used first.
 *
 * @public
 */
export function useSuggest(
  indexName: string,
  params: SuggestParams,
  options?: NarsilReadOptions,
): NarsilReadState<SuggestResult> {
  return useRead(
    ['suggest', indexName, params],
    (client, request) => client.suggest(indexName, params, request),
    options,
  )
}
