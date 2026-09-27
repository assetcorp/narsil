import type { FilterExpression } from './filters'
import type { DocumentProjection, SortSpec } from './search'

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
