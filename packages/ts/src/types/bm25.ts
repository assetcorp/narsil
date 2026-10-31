/**
 * The BM25 parameters of one text field, which override the same parameters at
 * the level that names the field.
 *
 * @public
 */
export interface BM25FieldParams {
  /** This saturates term frequency in this field. It takes a number from 0 to 1,000. */
  k1?: number
  /** This normalises by the length of this field. It takes a number from 0 to 1. */
  b?: number
}

/**
 * BM25 tuning for an index or for one search.
 *
 * Both parameters default to the values the literature settles on, so change
 * them only once you have measured relevance on your own corpus. For each
 * field, the engine takes the first value that is set among the search's value
 * for the field, the search's value, the index's value for the field, the
 * index's value, and the default.
 *
 * @public
 */
export interface BM25Params {
  /**
   * This saturates term frequency, so a higher value lets a repeated term
   * keep raising a score. It defaults to 1.2, and any value that is not a
   * number from 0 to 1,000 fails with `CONFIG_INVALID`.
   */
  k1?: number
  /**
   * This normalises by field length, from 0 for none to 1 for full. It
   * defaults to 0.75, and any value that is not a number from 0 to 1 fails
   * with `CONFIG_INVALID`.
   */
  b?: number
  /**
   * These parameters apply to the text fields that this map holds. A name that
   * is not a text field that the schema declares fails with `CONFIG_INVALID`
   * on an index and with `SEARCH_INVALID_FIELD` on a search.
   */
  fields?: Record<string, BM25FieldParams>
}
