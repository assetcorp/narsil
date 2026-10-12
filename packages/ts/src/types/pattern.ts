/**
 * This object holds the code with which the engine builds the pattern index of
 * each pattern field and answers `contains` and the other text tests on that
 * field.
 *
 * A Node process loads this code by itself. A browser bundle includes it only
 * where the app imports `patternSearch` from `@delali/narsil/pattern` and
 * passes it to {@link registerPatternSearch}, so a bundler can leave it out of
 * an app that has no pattern field.
 *
 * @public
 */
export interface PatternSearch {
  /** This is always `'pattern'`, the name of the code that the object holds. */
  readonly name: 'pattern'
}
