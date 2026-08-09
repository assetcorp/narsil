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
  /** The engine searches for this text, analysed with the index's own language module. */
  term?: string
  /** The engine searches the term in these fields, and in every text field in the schema by default. */
  fields?: string[]
  /** This narrows the candidates before scoring. */
  filters?: FilterExpression
  /** These multipliers raise or lower each field's contribution to the score, keyed by field. */
  boost?: Record<string, number>
  /** The query gathers term statistics this way, and follows the index's `defaultScoring` otherwise. */
  scoring?: ScoringMode
  /** The engine drops any hit scoring below this value. */
  minScore?: number
  /** A document has to carry this many query terms. The engine accepts one by default. */
  termMatch?: TermMatchPolicy
  /** A term may differ by this edit distance and still match, which is how a typo still finds its document. */
  tolerance?: number
  /** This many leading characters have to match exactly before `tolerance` applies, which keeps fuzzy matching honest. */
  prefixLength?: number
  /**
   * Treat the last query token as an unfinished word so it also matches
   * indexed terms that complete it ('secur' matches 'security'). Earlier
   * tokens must match fully; `tolerance` keeps applying to them but not to
   * the prefix token. Completions score against a shared document frequency
   * and are demoted below full-word matches. Ignored when `exact` is true.
   * Off by default.
   */
  prefix?: boolean
  /** Setting this matches the term as written, skipping stemming and fuzzy matching. */
  exact?: boolean
  /** These settings name the fields the query counts values for, and control how each count is cut and sorted. */
  facets?: FacetConfig
  /**
   * This sorts the hits by field value, which replaces the relevance ranking.
   * Pass an object keyed by field, or a list of fields in the order they
   * apply. Fusion defines the order of hybrid results, so a hybrid query takes
   * no sort. The engine throws `SEARCH_INVALID_MODE` for a query that sets
   * both.
   */
  sort?: SortSpec
  /** These settings collapse the hits into groups by field value. */
  group?: GroupConfig
  /** The query returns this many hits, and 10 by default. */
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
export type DocumentProjection = boolean | { include?: string[]; exclude?: string[] }

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
  /** The rankings merge this way, and by rank fusion by default. */
  strategy?: 'rrf' | 'linear'
  /** This rank-fusion constant softens the advantage of the top ranks, and `rrf` alone reads it. */
  k?: number
  /** This weights the vector score, from 0 to 1, and `linear` alone reads it. */
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
    /** The facet returns this many values for the field, most frequent first. */
    limit?: number
    /** This orders the returned values by their count. */
    sort?: 'asc' | 'desc'
    /** These ranges bucket a numeric field, instead of counting each value. */
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
  /** Each group keeps this many hits, and one by default, which is the collapse behaviour. */
  maxPerGroup?: number
  /** This folds each group's hits into one value, such as a sum or an average. */
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
 * The index has to have been created with `trackPositions`, because
 * highlighting reads the positions that setting records.
 *
 * @public
 */
export interface HighlightConfig {
  /** The engine highlights these fields. */
  fields: string[]
  /** This opens each match, and is `<mark>` by default. */
  preTag?: string
  /** This closes each match, and is `</mark>` by default. */
  postTag?: string
  /** A snippet runs to this many characters before the engine trims it. */
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
