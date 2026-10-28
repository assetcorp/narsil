/**
 * Vector-search inputs passed under `QueryParams.vector`.
 *
 * Supply either a raw `value` array or a `text` string for auto-embedding;
 * passing both throws `EMBEDDING_CONFIG_INVALID`. Result count is governed
 * by the outer query's `limit`, not by any field on this object.
 *
 * @public
 */
export interface VectorQueryConfig {
  /**
   * Name of the schema field that holds the vector to compare against.
   * Must reference a field declared as `vector[N]` in the index schema.
   */
  field: string
  /**
   * Raw query vector, given as a number array or a `Float32Array`. Length
   * must match the indexed field's dimension or the search rejects the
   * request with `VECTOR_DIMENSION_MISMATCH`.
   */
  value?: number[] | Float32Array
  /**
   * Text to embed at query time using the index or instance embedding
   * adapter. Mutually exclusive with `value`; requires a configured adapter.
   */
  text?: string
  /**
   * Score floor applied during ranking. Hits scoring below this value
   * are dropped before `limit` is enforced, so the returned hit count
   * can be smaller than `limit` even when more documents exist. The
   * floor is interpreted in score space for every metric; for
   * `euclidean`, distance is mapped to a similarity score of
   * `1 / (1 + distance)` first. Defaults to no floor.
   */
  similarity?: number
  /**
   * Similarity metric used for ranking. Defaults to `cosine`. Choose
   * `dotProduct` for raw inner-product scoring on already-normalised
   * vectors and `euclidean` for distance-based ordering.
   */
  metric?: 'cosine' | 'dotProduct' | 'euclidean'
  /**
   * HNSW exploration factor for approximate search. Higher values raise
   * recall at the cost of latency. Ignored while the field is still
   * served by the brute-force backend. Defaults to the engine's built-in
   * value when omitted.
   */
  efSearch?: number
  /**
   * How many times `limit` a quantized field re-scores against its
   * full-precision vectors before it returns the best `limit`. A value below
   * 1 or one that is not a finite number fails with `CONFIG_INVALID`. The
   * engine ignores this on a field whose quantization is `none`. When a query
   * omits it, the engine takes 3 for `osq1` and `osq2`, 2 for `osq8`, and 2
   * for `osq4` at 1,024 dimensions and above, but 5 for `osq4` below 1,024,
   * where a four-bit code ranks the true neighbours less reliably.
   */
  oversample?: number
}

/**
 * How a hybrid query merges its keyword ranking with its vector ranking.
 *
 * `rrf` combines the two by rank alone, which needs no tuning and handles
 * scores that live on different scales. `linear` blends the scores directly,
 * which gives you control once you know what each side's scores look like.
 *
 * @public
 */
export interface HybridConfig {
  /** The engine merges the rankings this way, and by rank fusion by default. It throws `CONFIG_INVALID` for any other value. */
  strategy?: 'rrf' | 'linear'
  /** The engine uses this rank-fusion constant under `rrf` alone, where a larger value reduces the lead of the top ranks. Set a whole number of at least 1, or leave it out for 60. The engine throws `CONFIG_INVALID` for any other value. */
  k?: number
  /** The engine uses this weight of the vector score, from 0 to 1, under `linear` alone, and 0.5 where you leave it out. It throws `CONFIG_INVALID` for a value outside that range. */
  alpha?: number
  /**
   * Where you set it, the engine fetches this many results from the keyword
   * search and from the vector search, fuses them, and pages through the top
   * `depth` of the fused list, so every page of one query comes from the same
   * fused order and a cursor can resume it. The last page stops at this depth,
   * so it can hold fewer hits than the limit. Set a whole number from 1 to
   * 10,000. The engine throws `CONFIG_INVALID` for any other value, and
   * `SEARCH_RESULT_WINDOW_EXCEEDED` for a page that starts at this depth or
   * beyond. Where you leave it out, each search fetches only enough results
   * to fill the page, so the fused order can change from one page to the next.
   */
  depth?: number
}
