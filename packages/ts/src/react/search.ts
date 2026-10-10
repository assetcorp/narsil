import type { PreflightResult, QueryResult, SuggestResult } from '../types/results'
import type { AnyDocument } from '../types/schema'
import type { QueryParams, SuggestParams } from '../types/search'
import type { NarsilReadOptions, NarsilReadState } from './options'
import { useProviderRead } from './read'

/**
 * This hook searches an index, then searches it again whenever the parameters
 * change and, under an engine, after each burst of writes to the index.
 *
 * Its parameters and its result match those of {@link SearchOperations.query}.
 * Set `keepPreviousData` for a search-as-you-type box, so that the hits
 * already on screen stay there while the next request is in flight.
 *
 * @typeParam T - This is the type of the stored documents, which also types the
 * `document` field of each hit.
 * @param indexName - This is the name of the index to search.
 * @param params - These set the text, the filters, the sort, and every other
 * part of the search.
 * @param options - These settings can switch the hook off, keep the last answer
 * on screen, and set the refresh interval, the headers, and the deadline.
 * @returns The state holds the result, the failure, the two loading flags, and
 * the `refresh` function.
 *
 * @public
 */
export function useQuery<T = AnyDocument>(
  indexName: string,
  params: QueryParams,
  options?: NarsilReadOptions,
): NarsilReadState<QueryResult<T>> {
  return useProviderRead(
    ['query', indexName, params],
    (reader, request) => reader.query<T>(indexName, params, request),
    options,
    indexName,
  )
}

/**
 * This hook counts the documents that a search matches without building or
 * ranking a single hit, which suits a result count beside a filter. Under an
 * engine, it counts again after each burst of writes to the index.
 *
 * @param indexName - This is the name of the index to count in.
 * @param params - These have the same form as the parameters of
 * {@link useQuery}.
 * @param options - These settings can switch the hook off, keep the last count
 * on screen, and set the refresh interval, the headers, and the deadline.
 * @returns The state holds the match count and the time that the count took.
 *
 * @public
 */
export function usePreflight(
  indexName: string,
  params: QueryParams,
  options?: NarsilReadOptions,
): NarsilReadState<PreflightResult> {
  return useProviderRead(
    ['preflight', indexName, params],
    (reader, request) => reader.preflight(indexName, params, request),
    options,
    indexName,
  )
}

/**
 * This hook completes a prefix from the terms that an index holds, so that a
 * search box can offer the completions as somebody types. Under an engine, it
 * completes the prefix again after each burst of writes to the index.
 *
 * @param indexName - This is the name of the index whose terms complete the
 * prefix.
 * @param params - These set the prefix and the number of completions to
 * return.
 * @param options - These settings can switch the hook off, keep the last
 * completions on screen, and set the refresh interval, the headers, and the
 * deadline.
 * @returns The state holds the completions, with the most widely used term
 * first.
 *
 * @public
 */
export function useSuggest(
  indexName: string,
  params: SuggestParams,
  options?: NarsilReadOptions,
): NarsilReadState<SuggestResult> {
  return useProviderRead(
    ['suggest', indexName, params],
    (reader, request) => reader.suggest(indexName, params, request),
    options,
    indexName,
  )
}
