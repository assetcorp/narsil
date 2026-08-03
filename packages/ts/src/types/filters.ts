/**
 * Compares one field against a value. Setting several keys narrows the match,
 * because a document has to satisfy all of them.
 *
 * @public
 */
export type ComparisonFilter = {
  /** This matches a field equal to the value. */
  eq?: number | string | boolean
  /** This matches a field holding anything other than the value. */
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
 * Everything {@link ComparisonFilter} offers, with the set and prefix tests a
 * string field also supports.
 *
 * @public
 */
export type StringFilter = ComparisonFilter & {
  /** This matches a field equal to any value in the list. */
  in?: string[]
  /** This matches a field equal to none of the values in the list. */
  nin?: string[]
  /** This matches a field starting with the text. */
  startsWith?: string
  /** This matches a field ending with the text. */
  endsWith?: string
}

/**
 * Tests the contents of an array field.
 *
 * @public
 */
export type ArrayFilter = {
  /** This matches an array holding every one of the values. */
  containsAll?: (string | number | boolean)[]
  /** This matches an array holding at least one of the values. */
  matchesAny?: (string | number | boolean)[]
  /** This compares the array's length. */
  size?: ComparisonFilter
}

/**
 * Tests whether a field carries a value at all, without looking at what it
 * holds.
 *
 * @public
 */
export type PresenceFilter = {
  /** This matches a document where the field is present. */
  exists?: boolean
  /** This matches a document where the field is absent. */
  notExists?: boolean
  /** This matches an empty string or an empty array. */
  isEmpty?: boolean
  /** This matches a string or array holding something. */
  isNotEmpty?: boolean
}

/**
 * Matches a `geopoint` field against a circle drawn on the earth.
 *
 * @public
 */
export type GeoRadiusFilter = {
  /** The filter tests the field against this circle. */
  radius: {
    /** The centre has this latitude, in degrees. */
    lat: number
    /** The centre has this longitude, in degrees. */
    lon: number
    /** The circle reaches this far, measured in `unit`. */
    distance: number
    /** `distance` is given in kilometres, miles, or metres. */
    unit: 'km' | 'mi' | 'm'
    /** This keeps the points inside the circle. Set it to false to keep the points outside. It is true by default. */
    inside?: boolean
    /** Setting this measures along the earth's curve instead of a flat approximation, which costs time and gains accuracy over long distances. */
    highPrecision?: boolean
  }
}

/**
 * Matches a `geopoint` field against a polygon drawn on the earth.
 *
 * @public
 */
export type GeoPolygonFilter = {
  /** The filter tests the field against this polygon. */
  polygon: {
    /** These corners run in order. The engine closes the ring, so repeating the first point is unnecessary. */
    points: Array<{ lat: number; lon: number }>
    /** This keeps the points inside the polygon. Set it to false to keep the points outside. It is true by default. */
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
 * The filter a query runs, built from per-field tests and the boolean
 * operators that combine them.
 *
 * Nest the operators to whatever depth the query needs. The engine applies the
 * filter before scoring, so a narrow filter makes a search cheaper.
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
