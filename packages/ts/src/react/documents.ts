import type { ListResult } from '../types/results'
import type { AnyDocument } from '../types/schema'
import type { ListParams } from '../types/search'
import type { NarsilReadOptions, NarsilReadState } from './options'
import { useProviderRead } from './read'

/**
 * This hook fetches one stored document, then fetches it again whenever the id
 * changes and, under an engine, after each burst of writes to the index.
 *
 * For a document that the index does not hold, the hook reports
 * `data: undefined` with no failure, so check `isLoading` to tell an empty
 * answer from one that is still in flight. A missing id switches the hook off,
 * which suits a detail panel until somebody picks a row.
 *
 * @param indexName - This is the name of the index that holds the document.
 * @param docId - This is the id of the document to fetch, where a nullish or
 * empty id switches the hook off.
 * @param options - These settings can switch the hook off, keep the last
 * document on screen, and set the refresh interval, the headers, and the
 * deadline.
 * @returns The state holds the document, the failure, the two loading flags,
 * and the `refresh` function.
 *
 * @public
 */
export function useDocument(
  indexName: string,
  docId: string | null | undefined,
  options?: NarsilReadOptions,
): NarsilReadState<AnyDocument | undefined> {
  const id = docId ?? ''
  const enabled = (options?.enabled ?? true) && id.length > 0
  return useProviderRead(
    ['get', indexName, id],
    (reader, request) => reader.get(indexName, id, request),
    { ...options, enabled },
    indexName,
  )
}

/**
 * This hook pages through the stored documents of an index without searching,
 * which suits a table of everything that the index holds. Under an engine, the
 * hook fetches the page again after each burst of writes to the index.
 *
 * @typeParam T - This is the type of the stored documents.
 * @param indexName - This is the name of the index to page through.
 * @param params - These set the page size, the cursor, and any filter, sort, or
 * projection.
 * @param options - These settings can switch the hook off, keep the last page
 * on screen, and set the refresh interval, the headers, and the deadline.
 * @returns The state holds the page and the cursor for the next page.
 *
 * @public
 */
export function useDocuments<T = AnyDocument>(
  indexName: string,
  params?: ListParams,
  options?: NarsilReadOptions,
): NarsilReadState<ListResult<T>> {
  return useProviderRead(
    ['listDocuments', indexName, params],
    (reader, request) => reader.listDocuments<T>(indexName, params, request),
    options,
    indexName,
  )
}
