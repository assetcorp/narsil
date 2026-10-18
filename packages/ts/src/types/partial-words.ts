/**
 * An app passes an object of this type to {@link registerPartialWordSearch}
 * to give the engine its partial-word search code. The engine uses that code
 * to match each query word inside the longer words of a field whose type
 * includes `partial`, whenever a query has {@link QueryParams.partialWords}
 * set.
 *
 * A Node process loads this code by itself. A browser bundle contains it only
 * when the app imports `partialWordSearch` from `@delali/narsil/partial-words`,
 * so a bundler can leave it out of an app that has no `partial` field.
 *
 * @public
 */
export interface PartialWordSearch {
  /** The engine checks that this name is `'partialWords'` when an app registers the object. */
  readonly name: 'partialWords'
}
