import type { EmbeddingAdapter, RerankAdapter } from './adapters'

/**
 * Registers the adapters that indexes and queries reach by name, which is
 * what lets a binding outlive a restart and reach a worker thread or another
 * node.
 *
 * @public
 */
export interface AdapterRegistrationOperations {
  /**
   * Registers an embedding adapter under a name that an index config can
   * give and that durability metadata keeps. Registering a name again binds
   * every index that gives that name to the new adapter.
   *
   * @param name - The name that an index config gives in `embedding.adapter`.
   * @param adapter - The adapter that embeds documents and queries.
   */
  registerEmbeddingAdapter(name: string, adapter: EmbeddingAdapter): void
  /**
   * Registers a rerank adapter under a name that a query gives in
   * `rerank.adapter`. Registering a name again sends every later query that
   * gives that name to the new adapter. The engine throws
   * `RERANK_CONFIG_INVALID` for an empty name and for an adapter without a
   * `rerank` function.
   *
   * @param name - The name that a query gives in `rerank.adapter`.
   * @param adapter - The adapter that scores the top hits of a query.
   */
  registerRerankAdapter(name: string, adapter: RerankAdapter): void
}
