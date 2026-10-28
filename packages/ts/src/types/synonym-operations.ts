import type { SynonymRule } from './synonyms'

/**
 * Reads and replaces the synonym set of an index, which
 * {@link IndexConfig.synonyms} sets when the index is created.
 *
 * @public
 */
export interface SynonymOperations {
  /**
   * Replaces the synonym set of an index, so that every search that starts
   * after the promise resolves expands its words with the new set.
   *
   * The engine applies the set without rebuilding the index, because a
   * synonym set changes no stored token. It saves the set with the index, so
   * the set stays in place after a restart, and every snapshot of the index
   * includes it. Where the index has copies on worker threads, the promise
   * resolves only once every copy uses the new set. Pass an empty list to
   * remove the set.
   *
   * @param indexName - The index whose set the engine replaces.
   * @param synonyms - The new set, in the shape that {@link SynonymRule}
   * describes.
   * @throws A `NarsilError` with `CONFIG_INVALID` when a rule breaks that
   * shape, when a word analyses to no token or to more than one, or when the
   * set passes 100,000 rules, 500,000 words, or 4,194,304 bytes of words in
   * UTF-8. The index then keeps the set that it held before the call.
   */
  updateSynonyms(indexName: string, synonyms: SynonymRule[]): Promise<void>
  /**
   * Returns the synonym set of an index with every word as the caller wrote
   * it, or an empty list when the index holds no set.
   *
   * @param indexName - The index whose set the engine returns.
   */
  getSynonyms(indexName: string): Promise<SynonymRule[]>
}
