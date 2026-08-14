import type { ListResult } from '../types/results'
import type { AnyDocument } from '../types/schema'
import type { ListParams } from '../types/search'
import type { NarsilReadOptions, NarsilReadState } from './options'
import { useRead } from './read'

/**
 * Reads one stored document, and reads it again whenever the id changes.
 *
 * A document the index does not hold comes back as `data: undefined` with no
 * failure, so read `isLoading` to tell an empty answer from one still on its
 * way. Passing no id switches the hook off, which is what a detail panel does
 * until somebody picks a row.
 *
 * @param indexName - This names the index holding the document.
 * @param docId - This names the document to read, and a nullish or empty id
 * switches the hook off.
 * @param options - These switch the hook off, keep the last document on screen,
 * and set the refresh interval, the headers, and the deadline.
 * @returns The state holds the document, the failure, the loading flags, and
 * the way to read it again.
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
  return useRead(['get', indexName, id], (client, request) => client.get(indexName, id, request), {
    ...options,
    enabled,
  })
}

/**
 * Pages through the stored documents without searching, which is what a table
 * of everything an index holds reads.
 *
 * @typeParam T - This is the shape of the stored documents.
 * @param indexName - This names the index to page through.
 * @param params - These set the page size, the cursor, and any filter, sort, or
 * projection.
 * @param options - These switch the hook off, keep the last page on screen, and
 * set the refresh interval, the headers, and the deadline.
 * @returns The state holds the page and the cursor that reaches the next one.
 *
 * @public
 */
export function useDocuments<T = AnyDocument>(
  indexName: string,
  params?: ListParams,
  options?: NarsilReadOptions,
): NarsilReadState<ListResult<T>> {
  return useRead(
    ['listDocuments', indexName, params],
    (client, request) => client.listDocuments<T>(indexName, params, request),
    options,
  )
}
