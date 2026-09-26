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
 * On a `string[]` field, the engine compares each element of the list, so
 * `eq`, `in`, `startsWith`, and `endsWith` match a document where one element
 * matches, and `ne` and `nin` match a document where no element matches.
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
  /** The engine tests the field against this circle. */
  radius: {
    /** The centre has this latitude, in degrees. */
    lat: number
    /** The centre has this longitude, in degrees. */
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
     * `SEARCH_INVALID_FILTER` for a ring of fewer than three corners, since
     * such a ring encloses no area. List the corners counter-clockwise around
     * the area, as in an exterior ring of GeoJSON. Where the corners
     * span 180 degrees of longitude or more, the engine matches the area on
     * the left of that path, so a ring listed that way can cross the
     * antimeridian or span more than half the globe.
     */
    points: Array<{ lat: number; lon: number }>
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
