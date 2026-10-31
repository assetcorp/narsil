import type { BM25Params } from './schema'

/**
 * Changes the BM25 setting of a live index, which
 * {@link IndexConfig.bm25} sets when the index is created.
 *
 * @public
 */
export interface BM25Operations {
  /**
   * Replaces the BM25 setting of an index, so that every search that starts
   * after the promise resolves scores under the new setting.
   *
   * The call replaces the whole setting, so a value that it leaves out returns
   * to its default, and `{}` clears the setting. The engine rebuilds nothing,
   * because the setting changes no stored token. It saves the setting with the
   * index, so the setting stays in place after a restart, and every snapshot
   * of the index includes it. Where the index has copies on worker threads,
   * the promise resolves only once every copy holds the new setting. A cursor
   * from before the change keeps working, and its next pages can repeat or
   * skip documents, because the scores that order them can change.
   *
   * @param indexName - The index whose setting the engine replaces.
   * @param bm25 - The new setting, in the shape that {@link BM25Params} describes.
   * @throws A `NarsilError` with `CONFIG_INVALID` when `k1` is not a number from
   * 0 to 1,000, when `b` is not a number from 0 to 1, or when `fields` holds a
   * name that is not a text field. The index then keeps the setting that it
   * held before the call.
   */
  updateBM25(indexName: string, bm25: BM25Params): Promise<void>
}
