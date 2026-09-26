import type { FilterExpression } from './filters'
import type { AnyDocument, ScoringMode } from './schema'

/**
 * Which engine answers a query: keyword matching, vector similarity, or both
 * merged into one ranking.
 *
 * @public
 */
export type SearchMode = 'fulltext' | 'vector' | 'hybrid'

/**
 * How many of a query's terms a document has to carry. `all` demands every
 * term, `any` accepts one, and a number demands that many.
 *
 * @public
 */
export type TermMatchPolicy = 'all' | 'any' | number

/**
 * One field of a sort, and the direction that field orders by.
 *
 * @public
 */
export interface SortField {
  /** The field the engine reads, which may name a nested field with dots. */
  field: string
  /** Ascending or descending order for this field. */
  direction: 'asc' | 'desc'
  /**
   * Where a document's field holds a list, the engine sorts that document by
   * one value from the list: the smallest under `'min'`, the largest under
   * `'max'`, and the mean or the median of the list's numbers under `'avg'`
   * or `'median'`. Where you leave this out, the engine uses `'min'` for an
   * ascending sort and `'max'` for a descending one. It sorts by a field that
   * holds a single value as that value stands, under every mode. It throws
   * `SEARCH_INVALID_FIELD` for `'avg'` or `'median'` on a field that the
   * schema declares as anything other than `number` or `number[]`.
   */
  mode?: 'min' | 'max' | 'avg' | 'median'
}

/**
 * A sort, either as an object keyed by field or as a list of fields in the
 * order they apply.
 *
 * Both forms order by the first field, break a tie on the second, and carry on
 * that way. Prefer the list where the order of the fields matters, because
 * JavaScript moves an all-digit key such as `2024` to the front of an object
 * and the list keeps the order you wrote.
 *
 * @public
 */
export type SortSpec = Record<string, 'asc' | 'desc'> | readonly SortField[]

/**
 * Everything {@link Narsil.query} accepts.
 *
 * Set `term` for keyword search, `vector` for similarity search, and `mode`
 * when you want both. The engine matches nothing for a query carrying neither
 * of them, so page through an index with {@link Narsil.listDocuments}
 * instead.
 *
 * @public
 */
export interface QueryParams {
  /** The engine analyses this text with the index's language module and searches for the terms that result. */
  term?: string
  /** The engine searches the term in these fields, and in every text field in the schema by default. */
  fields?: string[]
  /**
   * The engine scores only the documents that pass this filter. It throws
   * `SEARCH_INVALID_FILTER` for an operand of the wrong shape, and for an
   * operator on a field of another type, such as `startsWith` on a number
   * field.
   */
  filters?: FilterExpression
  /**
   * The engine multiplies the score from each named field by its weight. It
   * throws `SEARCH_INVALID_FIELD` for any field other than a text field that
   * the schema declares, and `CONFIG_INVALID` for a weight that is not a
   * finite number.
   */
  boost?: Record<string, number>
  /** The engine gathers term statistics this way, and follows the index's `defaultScoring` where the query sets none. */
  scoring?: ScoringMode
  /**
   * The engine drops any hit scoring below this value. It ranks with BM25,
   * which has no fixed upper bound, so a floor that suits one index and one
   * query can reject every hit in another.
   */
  minScore?: number
  /** The engine keeps a document only where it matches this many query terms, and one term is enough by default. */
  termMatch?: TermMatchPolicy
  /** The engine matches an indexed term within this edit distance of a query term, so a query with a typo still finds its document. */
  tolerance?: number
  /** The engine applies `tolerance` only to indexed terms that share this many leading characters with the query term, 2 by default. */
  prefixLength?: number
  /**
   * Setting this makes the engine treat the last query term as an unfinished
   * word, so `secur` matches `security`. The earlier terms must match whole,
   * and `tolerance` applies to them alone. The engine scores completions
   * against a shared document frequency and ranks them below whole-word
   * matches. It ignores this setting where `exact` is true, and the setting
   * defaults to false.
   */
  prefix?: boolean
  /**
   * Setting this makes the engine match each query term only against an equal
   * indexed term, which turns off fuzzy matching and prefix completion. The
   * engine still stems the query, because the index stores stemmed terms, so
   * `running` matches a document that holds `runs` through their shared stem.
   */
  exact?: boolean
  /**
   * The engine counts the values of these fields across the matching
   * documents, and each entry sets how it cuts and sorts that field's counts.
   * For a field outside the schema, it counts the values that the documents
   * store. It throws `SEARCH_INVALID_FIELD` for a `geopoint` or a vector
   * field.
   */
  facets?: FacetConfig
  /**
   * The engine sorts the hits by the values of these fields, in place of the
   * relevance ranking. Pass an object keyed by field, or a list of fields in
   * the order that the engine compares them. A sort can name a `number`,
   * `boolean`, `enum`, or `string:sortable` field, or a list field, which the
   * engine reduces to one value by the entry's `mode`. The engine throws
   * `SEARCH_INVALID_FIELD` for a sort on a plain `string`, a `geopoint`, or a
   * vector field, because ordering a plain string takes far more memory per
   * document than ordering a number, while the other two types have no order.
   * The engine orders hybrid results by fusion, so it throws
   * `SEARCH_INVALID_MODE` for a hybrid query that sets a sort, and it throws
   * the same code for a direction other than `asc` and `desc`.
   */
  sort?: SortSpec
  /** These settings collapse the hits into groups by field value. */
  group?: GroupConfig
  /**
   * The query returns this many hits, and 10 by default. Pass 0 to read the
   * match count with no hits. The engine reads a value below 0 as 0. It falls
   * back to the default for `NaN` and for an infinite value, so a page size
   * that you compute from user input never fails the query.
   */
  limit?: number
  /** The query skips this many hits before returning. A deep offset costs more than a cursor. */
  offset?: number
  /** This cursor comes from a previous result's `cursor`, and pages without an offset's cost. */
  searchAfter?: string
  /** These settings name the fields that come back with highlighted snippets. */
  highlight?: HighlightConfig
  /** These documents take fixed positions, ahead of the ranking. */
  pinned?: Array<{ docId: string; position: number }>
  /** This picks which engine answers the query. Keyword search runs by default. */
  mode?: SearchMode
  /** These vector-search inputs are required in `vector` and `hybrid` mode. */
  vector?: VectorQueryConfig
  /** These settings control how the keyword and vector rankings merge in `hybrid` mode. */
  hybrid?: HybridConfig
  /**
   * Setting this returns relevance scores on a sorted query. A query that
   * names a sort ranks by sort values alone and computes no scores, so its
   * hits carry none until this restores them. A query without a sort ignores
   * this and always carries scores.
   */
  includeScores?: boolean
  /** Setting this returns the numbers behind each hit's score, which is what you read when a ranking surprises you. */
  includeScoreComponents?: boolean
  /** This chooses how much of each stored document comes back, and the whole document by default. */
  document?: DocumentProjection
}

/**
 * How much of a stored document each hit carries back.
 *
 * Pass `false` when the ids and scores are all you need, and every hit's
 * `document` is then an empty object. Pass `include` to keep named fields
 * alone, or `exclude` to drop named fields and keep the rest; naming both
 * keeps the included fields and then drops the excluded ones from those. Use
 * dots to name a nested field, so `author.name` addresses the `name` inside
 * `author`, and a name that matches no field changes nothing.
 *
 * Drop a vector field on a similarity search, because the engine otherwise
 * reads every hit's vector back out of the index and writes it into the
 * response.
 *
 * @public
 */
export type DocumentProjection =
  | boolean
  | {
      /** Names the fields to keep, so every field left out of this list is dropped. */
      include?: string[]
      /** Names the fields to drop, so every other field is kept. */
      exclude?: string[]
    }

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
}

/**
 * Fields a query counts values for, keyed by field name.
 *
 * @public
 */
export interface FacetConfig {
  /** Each key names a field the query counts values for. */
  [field: string]: {
    /** The engine returns this many values for the field, in the order of `sort`. */
    limit?: number
    /** The engine orders the returned values by their count, putting the highest first under `'desc'`, which is the default, and the lowest first under `'asc'`. */
    sort?: 'asc' | 'desc'
    /** The engine counts a numeric field's matches into these ranges, with one count for each range. */
    ranges?: Array<{ from: number; to: number }>
  }
}

/**
 * How a query collapses its hits into groups.
 *
 * @public
 */
export interface GroupConfig {
  /** The values of these fields define a group, and several fields group by their combination. */
  fields: string[]
  /** The engine returns this many hits from each group, best first, and one hit where you leave this out. */
  maxPerGroup?: number
  /** The engine returns this many groups, best first, and every group where you leave this out. */
  limit?: number
  /**
   * The engine folds every hit of each group into one value, such as a sum or
   * an average, including the hits beyond `maxPerGroup`. In cluster mode the
   * coordinator fetches up to 10,000 hits of each group to fold.
   */
  reduce?: GroupReducer
}

/**
 * Folds the hits of one group into a single value.
 *
 * @public
 */
export type GroupReducer = {
  /**
   * Folds one hit into the running value.
   *
   * @param accumulator - What the previous call returned, or what
   * `initialValue` produced for the first hit.
   * @param doc - The hit's stored document.
   * @param score - The hit's relevance score.
   * @returns The new running value.
   */
  reducer: (accumulator: unknown, doc: AnyDocument, score: number) => unknown
  /** Produces the starting value for each group. The engine calls it once per group. */
  initialValue: () => unknown
}

/**
 * Which fields a query returns highlighted snippets for, and how those
 * snippets are marked up.
 *
 * The engine analyses the text of each returned field again and marks every
 * word that the query matches. That covers a word whose stem equals a query
 * stem, a word within the query's `tolerance` of a query stem, and, for a
 * `prefix` query, a word that completes the last query term. The engine
 * therefore marks the same words whatever the index's `trackPositions`
 * setting is.
 *
 * @public
 */
export interface HighlightConfig {
  /** The engine highlights these fields. */
  fields: string[]
  /** The engine writes this before each match, and writes `<mark>` by default. */
  preTag?: string
  /** The engine writes this after each match, and writes `</mark>` by default. */
  postTag?: string
  /**
   * The engine takes this many characters of the field around the densest run
   * of matches, 200 by default. It returns a snippet longer than that number,
   * because it then adds the opening and closing tags, and an ellipsis at each
   * end where it cuts the field.
   */
  maxSnippetLength?: number
}

/**
 * Everything {@link Narsil.suggest} accepts.
 *
 * @public
 */
export interface SuggestParams {
  /** The returned terms complete this text. */
  prefix: string
  /** The lookup returns this many completions, most widely used first, and 10 by default. */
  limit?: number
}

/**
 * Everything {@link Narsil.listDocuments} accepts.
 *
 * {@link Narsil.listDocuments} reads the stored documents without ranking them,
 * which is how you page through a whole index. Leave `cursor` out to start at
 * the first document, then pass back the cursor each result carries until it
 * comes back null.
 *
 * A cursor belongs to the sort it was made under, so pass the same `sort` back
 * with it. Changing `sort` invalidates the cursor, and the engine then throws
 * `SEARCH_INVALID_CURSOR` rather than returning a page from the wrong order.
 *
 * @public
 */
export interface ListParams {
  /**
   * This cursor comes from a previous result, and continues where it stopped.
   * The engine ties a cursor to the sort that produced it, and it throws
   * `SEARCH_INVALID_CURSOR` for a cursor sent back under a different sort.
   */
  cursor?: string
  /** The page carries this many documents, and 10 by default. The engine raises a value below one to one. */
  limit?: number
  /** This narrows the listing to the documents the filter accepts. */
  filters?: FilterExpression
  /**
   * This orders the listing by field value rather than by document id, and the
   * engine applies the fields in the order they are listed. Pass an object
   * keyed by field, or a list of fields in the order they apply. It breaks a
   * tie on document id, and it sorts by at most eight fields. The engine uses
   * document-id order when you leave this out.
   *
   * The engine reads every document the listing covers to build a sorted page,
   * so a sorted listing costs more than the default order on a large index.
   */
  sort?: SortSpec
  /** This chooses how much of each stored document comes back, and the whole document by default. */
  document?: DocumentProjection
}
