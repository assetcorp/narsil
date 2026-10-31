/**
 * The analysis settings that {@link AnalysisOperations.changeAnalysis} changes
 * on a live index. A key that you leave out keeps its current value.
 *
 * @public
 */
export interface AnalysisChange {
  /** This is the name of a registered language. */
  language?: string
  /**
   * This is a name that `registerTokenizer` bound. Pass `null` to return to the
   * tokeniser of the language.
   */
  tokenizer?: string | null
  /**
   * This is a name that `registerStopWords` bound, or a list of words. Pass
   * `null` to return to the stop words of the language.
   */
  stopWords?: string | readonly string[] | ReadonlySet<string> | null
}

/**
 * Changes how an index turns text into terms while the index keeps answering
 * searches.
 *
 * @public
 */
export interface AnalysisOperations {
  /**
   * Gives you an index that matches text under new settings, with no downtime
   * and no reindex on your side.
   *
   * The engine builds the new terms beside the old ones. Searches and writes
   * carry on under the old settings during that time, and every write that the
   * engine accepts reaches the new terms. Each search then matches under one
   * set of settings, either the old or the new. Vector data stays as it is. The
   * promise resolves once a durable checkpoint holds the new terms, or once the
   * switch has happened on an engine without durability. A restart at any point
   * finishes the change.
   *
   * @param indexName - The index to change.
   * @param change - The settings to change. A change to the values that the
   * index already holds completes with no rebuild.
   * @throws A `NarsilError` with `LANGUAGE_NOT_SUPPORTED` for an unregistered
   * language, with `CONFIG_INVALID` for an unregistered name, a tokeniser
   * instance, a stop word function, or a synonym word that breaks the synonym
   * rules under the new settings, with `ANALYSIS_REBUILD_MEMORY_EXCEEDED` when a
   * second copy of the terms does not fit in memory, with
   * `ANALYSIS_CHANGE_REPLACED` when a later change or a restore replaces this
   * one, and with `PARTITION_REBALANCING_BACKPRESSURE` during a rebalance.
   */
  changeAnalysis(indexName: string, change: AnalysisChange): Promise<void>
}
