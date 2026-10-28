/**
 * How a query reorders its top hits with a rerank adapter.
 *
 * The engine ranks the query as it would without this setting, passes the
 * top `window` hits to the adapter, and orders them by the adapter's scores.
 * The hits past the window follow in their first ranking, with their scores
 * scaled below the lowest reranked score, so every page of one query comes
 * from the same order.
 *
 * @public
 */
export interface RerankConfig {
  /**
   * The engine scores the hits with the rerank adapter registered under this
   * key. It throws `RERANK_CONFIG_INVALID` for a key that it has not
   * registered.
   */
  adapter: string
  /**
   * The engine sends the adapter the values of these text fields, in this
   * order and joined with newlines, as the text of each hit. Each member of a
   * list field takes a line of its own. The engine throws
   * `RERANK_CONFIG_INVALID` for an empty list, for a field that the schema
   * does not declare as text, and for a field that the list gives twice.
   */
  fields: string[]
  /**
   * The adapter compares each hit with this text. Where you leave it out, the
   * engine sends the query's `term`, or else its `vector.text`, and it throws
   * `RERANK_CONFIG_INVALID` where the query carries neither.
   */
  query?: string
  /**
   * The engine reranks this many of the top hits, from 1 to the engine's
   * `maxRerankWindow`. Where you leave it out, the engine reranks the
   * smallest of 100, `maxRerankWindow`, and, where a hybrid query sets it,
   * `hybrid.depth`. A hybrid query that sets `hybrid.depth` reranks its fused
   * list at that depth, so the engine throws `RERANK_CONFIG_INVALID` when you
   * set a window above it.
   */
  window?: number
}
