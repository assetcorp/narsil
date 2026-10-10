/**
 * With this object, the engine builds the pattern index of every pattern
 * field and tests `contains` and the other text filters on such a field.
 *
 * A Node process loads this code by itself. A browser bundle includes it only
 * where the app imports `patternSearch` from `@delali/narsil/pattern` and
 * passes it to {@link registerPatternSearch}, so an app that declares no
 * pattern field downloads none of it.
 *
 * @public
 */
export interface PatternSearch {
  /** This names the capability that the object provides. */
  readonly name: 'pattern'
}
