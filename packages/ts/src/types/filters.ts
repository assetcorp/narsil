/**
 * Compares one field against a value. Setting several keys narrows the match,
 * because a document has to satisfy all of them.
 *
 * @public
 */
export type ComparisonFilter = {
  /** This matches a field equal to the value, or a list field where one element equals it. */
  eq?: number | string | boolean
  /**
   * This matches a document that holds the field with a value other than this
   * one, or a list field where every element differs from it, which an empty
   * list does.
   */
  ne?: number | string | boolean
  /** This matches a field greater than the number. */
  gt?: number
  /** This matches a field less than the number. */
  lt?: number
  /** This matches a field greater than or equal to the number. */
  gte?: number
  /** This matches a field less than or equal to the number. */
  lte?: number
  /** This matches a field inside the inclusive range, given as `[low, high]`. */
  between?: [number, number]
}

/**
 * The engine tests a text field against this filter for equality, for a text
 * range, or with the set, prefix, and pattern tests.
 *
 * On a `string[]`, `verbatim[]`, or `enum[]` field, the engine tests each
 * element of the list on its own. A document passes `eq`, `in`, `startsWith`,
 * `endsWith`, `contains`, `wildcard`, or `regex` when one element passes the
 * test. However, a document passes `ne` or `nin` only when every element
 * differs from the values.
 *
 * The engine applies the range tests `gt`, `gte`, `lt`, `lte`, and `between`
 * to a single `string` or `verbatim` field whose type includes `sortable`. It
 * throws `SEARCH_INVALID_FILTER` for a text range on any other field. It
 * orders the values as a sort on the field does, so it compares their case
 * folds first and compares their raw code points only where the folds are
 * equal.
 *
 * A pattern field is a `verbatim` or `verbatim[]` field, or a `string` or
 * `string[]` field whose type includes `pattern`. On a pattern field, the
 * engine answers `eq`, `ne`, `in`, `nin`, `startsWith`, `endsWith`,
 * `contains`, `wildcard`, and `regex` from the field's pattern index, and
 * `caseFold` applies to each of those tests. The engine compares the code
 * points of each value as they are stored, with no Unicode normalisation.
 *
 * On an `enum` or `enum[]` field, the engine answers `eq`, `ne`, `in`, `nin`,
 * `startsWith`, and `endsWith` from the field's index of values. A `string` or
 * `string[]` field whose type leaves out `pattern` keeps no index of whole
 * values, so the engine throws `SEARCH_INVALID_FILTER` for those six tests,
 * and for `matchesAny` and `containsAll`, on such a field.
 *
 * The engine also throws `SEARCH_INVALID_FILTER` in these cases:
 *
 * - The filter sets `contains`, `wildcard`, `regex`, or `caseFold` on a field
 *   that is not a pattern field.
 * - The text or the pattern of a test on a pattern field holds more than 1,024
 *   code points.
 * - A literal test under `caseFold` has a text whose case fold holds more than
 *   2,048 code points.
 * - A `wildcard` or `regex` pattern breaks its syntax or one of its limits.
 *
 * @public
 */
export type StringFilter = Pick<ComparisonFilter, 'eq' | 'ne'> & {
  /** This matches a value that comes after the text in sort order. */
  gt?: string
  /** This matches a value that comes before the text in sort order. */
  lt?: string
  /** This matches a value equal to the text or after it in sort order. */
  gte?: string
  /** This matches a value equal to the text or before it in sort order. */
  lte?: string
  /** This matches a value inside the inclusive range in sort order, given as `[low, high]`. */
  between?: [string, string]
  /** This matches a field equal to any value in the list, which holds at most 65,536 values. */
  in?: string[]
  /** This matches a field that differs from every value in the list, which holds at most 65,536 values. */
  nin?: string[]
  /** This matches a field starting with the text. */
  startsWith?: string
  /** This matches a field ending with the text. */
  endsWith?: string
  /** This matches a pattern field whose value holds the text anywhere in it. */
  contains?: string
  /**
   * This matches a pattern field when the whole value matches the wildcard
   * pattern. For example, `INV-*-2024` matches `INV-0042-2024`.
   *
   * In the pattern, `*` matches any sequence of code points, including an
   * empty one, and `?` matches exactly one code point. Write `\` before a code
   * point to match that code point itself, so `\*` matches an asterisk.
   *
   * The engine throws `SEARCH_INVALID_FILTER` for a pattern that ends in a
   * `\` with no code point after it. It throws the same error for a pattern
   * with more than 2,048 positions. Each `*`, each `?`, and each other code
   * point counts as one position, except that under `caseFold` a code point
   * counts once for each code point of its case fold.
   */
  wildcard?: string
  /**
   * This matches a pattern field when some part of the value matches the
   * regular expression. `^` and `$` match only at the start and at the end of
   * the whole value.
   *
   * The engine accepts literal code points, `.`, `\d`, `\w`, and `\s`, sets
   * such as `[a-z]` and `[^0-9]`, groups, and `|`. It also accepts the repeats
   * `*`, `+`, `?`, `{n}`, `{n,}`, and `{n,m}`, the anchors `^` and `$`, the
   * word edge `\b`, and number ranges such as `<1-65535>`. A number range
   * matches the digits of any whole number from its low end to its high end.
   * Write `\` before an ASCII punctuation mark to match the mark itself. The
   * `.` matches any code point, including a line break.
   *
   * The matcher never backtracks, so it checks a value in at most as many
   * steps as the value's code points multiplied by the pattern's positions.
   *
   * The engine throws `SEARCH_INVALID_FILTER` for any construct outside that
   * syntax, such as a back-reference, a lookaround, a lazy repeat, or an inline
   * flag. It throws the same error when the groups of a pattern nest more than
   * 32 deep, when a count is above 2,048, and when a pattern holds more than
   * 2,048 positions. When the operator of an HTTP server sets its `allowRegex`
   * option to false, the server refuses every `regex` test.
   */
  regex?: string
  /**
   * When this is true, the engine compares the case fold of each value of a
   * pattern field with the case fold of the text, so a test for `error`
   * matches `ERROR`. It applies to `eq`, `ne`, `in`, `nin`, `startsWith`,
   * `endsWith`, `contains`, `wildcard`, and `regex`.
   *
   * Under `caseFold`, a set that does not open with `^` can also match a
   * sequence of code points. When a member that the set holds on its own folds
   * to several code points, the set matches that whole fold, so `[ß]` matches
   * `ss`.
   */
  caseFold?: boolean
  /**
   * This lets the `eq` test of a pattern field match a value within this many
   * edits of the text, so a test for `INV-2O24` with a tolerance of 1 matches
   * `INV-2024`. An edit inserts, deletes, or replaces one code point, so a
   * swap of two neighbouring code points counts as two edits. With `caseFold`,
   * the engine counts the edits between the case folds of the value and the
   * text. The tolerance applies to `eq` alone, so the other tests of the field
   * still compare exactly.
   *
   * The engine takes its candidates from the pattern index, so the case fold
   * of the text has to hold enough distinct runs of three code points. For a
   * tolerance of `k`, the engine needs `k × (2 + f) + 1` runs, where `f` is
   * the number of code points in the longest case fold among the text's code
   * points, which is 1 for most text. A tolerance of 1 on `INV-2O24`
   * therefore needs 4 of its 6 runs, while a tolerance of 2 needs 7. Under
   * `'auto'`, the engine uses 2 where the text holds enough runs for 2,
   * otherwise 1 where it holds enough for 1, and otherwise 0.
   *
   * The engine throws `SEARCH_INVALID_FILTER` for a tolerance of 1 or 2 on a
   * text with too few runs, stating how many runs that tolerance needs. It
   * throws the same error for any other tolerance, for a tolerance on a field
   * that is not a pattern field, and for a tolerance in a filter without an
   * `eq` test. Towards the pattern work cap, it counts one unit for each cell
   * that it fills in the table of edit distances between the text and a
   * value.
   */
  tolerance?: 0 | 1 | 2 | 'auto'
}

/**
 * Tests the contents of a list field, which is a `number[]`, `boolean[]`,
 * `enum[]`, `verbatim[]`, or `string[]` field.
 *
 * The engine throws `SEARCH_INVALID_FILTER` for these tests on any other
 * field, for a value whose type differs from the type of the list's elements,
 * and for `containsAll` or `matchesAny` on a `string[]` field whose type leaves
 * out `pattern`.
 *
 * @public
 */
export type ArrayFilter = {
  /** This matches a list holding every one of the values, at most 65,536 of them, so an empty set of values matches every list. */
  containsAll?: (string | number | boolean)[]
  /** This matches a list holding at least one of the values, at most 65,536 of them. */
  matchesAny?: (string | number | boolean)[]
  /** This compares the number of elements in the list. */
  size?: ComparisonFilter
}

/**
 * Tests whether a field carries a value at all, without looking at what it
 * holds.
 *
 * @public
 */
export type PresenceFilter = {
  /** This matches a document where the field holds a value other than null. */
  exists?: boolean
  /** This matches a document where the field is absent or null. */
  notExists?: boolean
  /** This matches a document where the field is absent, null, an empty string, or an empty list. */
  isEmpty?: boolean
  /** This matches a document where the field holds a value other than an empty string or an empty list. */
  isNotEmpty?: boolean
}

/**
 * Matches a `geopoint` field against a circle drawn on the earth.
 *
 * @public
 */
export type GeoRadiusFilter = {
  /** The engine tests the field against this circle. */
  radius: {
    /** The centre has this latitude, in degrees from -90 to 90. For any other value, the engine throws `SEARCH_INVALID_FILTER`. */
    lat: number
    /** The centre has this longitude, in degrees from -180 to 180. For any other value, the engine throws `SEARCH_INVALID_FILTER`. */
    lon: number
    /** The circle has this radius, measured in `unit`. */
    distance: number
    /**
     * The engine measures `distance` in kilometres under `'km'`, in miles
     * under `'mi'`, and in metres under `'m'`. For any other unit, it throws
     * `SEARCH_INVALID_FILTER`.
     */
    unit: 'km' | 'mi' | 'm'
    /** The engine matches the points inside the circle while this is true, which is the default, and the points outside it while this is false. */
    inside?: boolean
    /**
     * The engine measures each distance with the Haversine formula on a sphere
     * by default, and with Vincenty's formula on the WGS-84 ellipsoid while
     * this is true. Vincenty's formula iterates, so the engine takes longer
     * to compute each distance. The two formulas differ by less than 0.3% under about
     * 100 km, while across a continent they can differ by up to 0.5%.
     */
    highPrecision?: boolean
  }
}

/**
 * Matches a `geopoint` field against a polygon drawn on the earth.
 *
 * @public
 */
export type GeoPolygonFilter = {
  /** The engine tests the field against this polygon. */
  polygon: {
    /**
     * The engine closes the ring through these corners in the order that you
     * list them, so you can leave the first point off the end. It throws
     * `SEARCH_INVALID_FILTER` for a ring of fewer than three corners, which
     * encloses no area, and for a corner whose latitude is outside -90 to 90
     * or whose longitude is outside -180 to 180. It also throws that error for
     * a ring of more than 65,536 corners. List the corners counter-clockwise
     * around the area, as in an exterior ring of GeoJSON. Where the corners
     * span 180 degrees of longitude or more, the engine matches the area on
     * the left of that path, so a ring listed that way can cross the
     * antimeridian or span more than half the globe.
     */
    points: Array<{
      /** The corner has this latitude, in degrees. */
      lat: number
      /** The corner has this longitude, in degrees. */
      lon: number
    }>
    /** The engine matches the points inside the polygon while this is true, which is the default, and the points outside it while this is false. */
    inside?: boolean
  }
}

/**
 * Either shape a `geopoint` field is matched against.
 *
 * @public
 */
export type GeoFilter = GeoRadiusFilter | GeoPolygonFilter

/**
 * The filter one field accepts. Which of these forms applies follows from the
 * field's declared type.
 *
 * @public
 */
export type FieldFilter = ComparisonFilter | StringFilter | ArrayFilter | PresenceFilter | GeoFilter

/**
 * The filter that a query runs, built from per-field tests and the boolean
 * operators that combine them.
 *
 * The engine answers every test from an index that it keeps for the field. It
 * applies the filter before scoring, so a narrow filter makes a search
 * cheaper. A filter nests at most 30 levels deep and holds at most 1,024
 * tests, counted across every field and nested expression. Past either limit,
 * the engine throws `SEARCH_INVALID_FILTER`, while it throws
 * `SEARCH_INVALID_FIELD` for a test on a field that the schema leaves out.
 *
 * @public
 */
export type FilterExpression = {
  /** These per-field tests are keyed by field name, and a document has to satisfy every entry. */
  fields?: Record<string, FieldFilter>
  /** Every nested expression has to match. */
  and?: FilterExpression[]
  /** At least one nested expression has to match. */
  or?: FilterExpression[]
  /** The nested expression has to fail. */
  not?: FilterExpression
}
