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
   * The engine keeps this many candidates as it walks the HNSW graph, so a
   * higher value can find more of the true neighbours, although each query
   * takes longer. The engine applies it only once the field holds a graph.
   * The engine fetches k hits, where k is one more than the number of hits up
   * to the end of the page, so k is `limit` plus 1 on a first page. When a
   * query leaves `efSearch` unset, the engine keeps the larger of 50 and k
   * plus a margin, where the margin is 50 below 768 dimensions, 75 from 768
   * to 1,023 dimensions, and 0 at 1,024 dimensions and above. Under a
   * filter, the engine counts only the candidates that pass the filter.
   */
  efSearch?: number
  /**
   * The engine re-scores this many times k candidates in a quantized field
   * against the full-precision vectors before it returns the best `limit`,
   * where k is one more than the number of hits up to the end of the page, so
   * k is `limit` plus 1 on a first page. For a value below 1, or for a value
   * that is not a finite number, the engine throws a `NarsilError` with code
   * `CONFIG_INVALID`. The engine ignores it on a field whose quantization is
   * `none`. When a query leaves it unset, the engine sets the number of
   * candidates that it re-scores from k and from the field's dimension. It
   * rounds that number up, and it re-scores at least k candidates. Below 768
   * dimensions, it re-scores 3.23k + 55.9√k under `osq1` and 2.6k + 17√k under
   * `osq2`. From 768 to 1,023 dimensions, it re-scores 2.2k + 27√k under
   * `osq1` and k + 16√k under `osq2`. At 1,024 dimensions and above, it
   * re-scores 3k under both. Under `osq4`, it re-scores 5k below 1,024
   * dimensions and 2k from 1,024 dimensions, while under `osq8` it re-scores
   * 2k at every dimension. Under a filter, the engine counts only the
   * candidates that pass the filter.
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
}
