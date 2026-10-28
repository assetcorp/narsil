import type { FilterExpression } from './filters'
import type { RerankConfig } from './rerank'
import type { AnyDocument, ScoringMode } from './schema'
import type { HybridConfig, VectorQueryConfig } from './vector-query'

export type { ListParams, SuggestParams } from './reads'
export type { RerankConfig } from './rerank'
export type { HybridConfig, VectorQueryConfig } from './vector-query'

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
  /**
   * The engine keeps a document only where the document matches this many
   * query terms, under the same `tolerance` and `prefixLength` that the search
   * uses. One term is enough by default.
   */
  termMatch?: TermMatchPolicy
  /**
   * The engine matches an indexed term within this edit distance of a query
   * term, so it finds a document for a query with a typo. It counts each
   * Unicode code point as one character. Set an integer from 0 to 10.
   */
  tolerance?: number
  /**
   * The engine applies `tolerance` only to the indexed terms that share this
   * many leading characters with the query term, or to the terms that start
   * with the whole query term when the query term is shorter. Set an integer
   * from 0 to 1,024; the default is 2.
   */
  prefixLength?: number
  /**
   * With this set, the engine treats the last query term as an unfinished
   * word, so `secur` matches `security`. The engine matches that last term by
   * its stem or by completing it, while `tolerance` applies only to the earlier
   * terms, which have to match whole. The engine scores completions against a
   * shared document frequency. It also ranks them below whole-word matches.
   * The engine ignores this setting where `exact` is true, and the setting is
   * false by default.
   */
  prefix?: boolean
  /**
   * With this set, the engine also matches each query word of three or more
   * characters inside the longer words of every field whose type includes
   * `partial`, so a search for `proof` matches a document with `waterproof`
   * in such a field. The engine counts each Unicode code point as one
   * character. It looks for the query word, before stemming, inside each word
   * exactly as that word appears in a document.
   *
   * The engine adds at most 50 such words to a query, which it divides as
   * evenly as it can among the query words. Within the share of each query
   * word, it adds first the words that the most documents contain. It scores
   * a match inside a longer word in proportion to the part of that word that
   * the query word makes up, so it scores such a match below a whole-word
   * match at the same frequency in a field of the same length. With
   * `highlight`, it tags each whole word that contains a query word in a
   * searched `partial` field.
   *
   * The engine applies no `tolerance` to these matches. It ignores this
   * setting where `exact` is true or where the searched fields include no
   * `partial` field. Where the setting is absent, the engine treats it as
   * false, while it throws `CONFIG_INVALID` for any value other than `true`
   * or `false`.
   */
  partialWords?: boolean
  /**
   * With this set, the engine matches each query term only against an equal
   * indexed term, so it turns off fuzzy matching, prefix completion, and
   * partial-word matching. The engine still stems the query, because the
   * index stores stemmed terms, so a search for `running` matches a document
   * that contains `runs` through the stem that both words share.
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
   * the order that the engine compares them. The engine sorts by a `number`,
   * `boolean`, or `enum` field, by a text field whose type includes
   * `sortable`, or by a list of any of these, which it reduces to one value by
   * the entry's `mode`. It throws `SEARCH_INVALID_FIELD` for a sort on a
   * `geopoint` or a vector field, because neither type has an order. It throws
   * the same code for a sort on any other text field, since the engine keeps
   * up to the first 512 code points of every document's value in memory to
   * sort by a text field. The engine orders hybrid results by fusion, so it
   * throws `SEARCH_INVALID_MODE` for a sort on a hybrid query. It also throws
   * that code for a direction other than `asc` and `desc`.
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
   * These settings reorder the top hits with a rerank adapter, such as a
   * cross-encoder, after the keyword, vector, or hybrid ranking. The count
   * matches the count of the same query without `rerank`, while the facets
   * and the groups come from the first ranking. The engine throws
   * `SEARCH_INVALID_MODE` for a query that also sets a sort, and
   * `RERANK_FAILED` where the adapter fails or outlasts the engine's
   * `rerankTimeout`.
   */
  rerank?: RerankConfig
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
 * Fields a query counts values for, keyed by field name.
 *
 * @public
 */
export interface FacetConfig {
  /** Each key names a field the query counts values for. */
  [field: string]: {
    /** The engine returns this many values for the field, in the order of `sort`. An engine returns every value where you leave this out, while a cluster returns 10, or every range of a field that sets `ranges`. */
    limit?: number
    /** The engine orders the returned values by their count, putting the highest first under `'desc'`, which is the default, and the lowest first under `'asc'`. Under `'asc'`, each cluster node sends the count of up to 10,000 values of the field, so the lowest counts are exact wherever no node holds more values than that. */
    sort?: 'asc' | 'desc'
    /** The engine counts a numeric field's matches into these ranges, with one count for each range. A cluster search counts up to 1,000 ranges on a field and throws `CONFIG_INVALID` for more. */
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
 * This configuration names the fields that receive highlighted snippets. It
 * also sets how the engine marks those snippets up.
 *
 * The engine analyses the text of each returned field again to tag every word
 * that it matched, so it tags the same words whatever the index's
 * `trackPositions` setting is. It tags a word whose stem equals a query stem,
 * and a word within the query's `tolerance` of a query stem. For a `prefix`
 * query, it tags a word for the last query term only when that word completes
 * the term or shares its stem.
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
