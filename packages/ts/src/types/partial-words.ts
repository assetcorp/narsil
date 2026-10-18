/**
 * This object holds the code with which the engine matches a query word
 * inside the longer words of each field whose type includes `partial`, which
 * a query asks for with `partialWords`.
 *
 * A Node process loads this code by itself. A browser bundle includes it only
 * where the app imports `partialWordSearch` from `@delali/narsil/partial-words`
 * and passes it to {@link registerPartialWordSearch}, so a bundler can leave it
 * out of an app that has no `partial` field.
 *
 * @public
 */
export interface PartialWordSearch {
  /** This is always `'partialWords'`, the name of the code that the object holds. */
  readonly name: 'partialWords'
}
