import type { PreflightResult, QueryResult, SuggestResult } from '../types/results'
import type { AnyDocument } from '../types/schema'
import type { QueryParams, SuggestParams } from '../types/search'
import type { NarsilReadOptions, NarsilReadState } from './options'
import { useRead } from './read'

/**
 * Searches an index, and searches again whenever the parameters change or,
 * under an engine, after a write to the index.
 *
 * The parameters and the answer match those of {@link SearchOperations.query}.
 * Set `keepPreviousData` for a search-as-you-type box, so that the hits
 * already on screen stay there while the next answer loads.
 *
 * @typeParam T - This is the shape of the stored documents, which flows through
 * to each hit's `document`.
 * @param indexName - This names the index to search.
 * @param params - These set the text, the filters, the sort, and everything
 * else in the search.
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
    (reader, request) => reader.query<T>(indexName, params, request),
    options,
    indexName,
  )
}

/**
 * Counts what a search would match, without building or ranking a single hit,
 * which suits a result count beside a filter.
 *
 * @param indexName - This names the index to count in.
 * @param params - These are the parameters of {@link useQuery}.
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
    (reader, request) => reader.preflight(indexName, params, request),
    options,
    indexName,
  )
}

/**
 * Completes a prefix from the terms that an index holds, ready to offer under a
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
    (reader, request) => reader.suggest(indexName, params, request),
    options,
    indexName,
  )
}
