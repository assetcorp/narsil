export type ComparisonFilter = {
  eq?: number | string | boolean
  ne?: number | string | boolean
  gt?: number
  lt?: number
  gte?: number
  lte?: number
  between?: [number, number]
}

export type StringFilter = ComparisonFilter & {
  in?: string[]
  nin?: string[]
  startsWith?: string
  endsWith?: string
}

export type ArrayFilter = {
  containsAll?: (string | number | boolean)[]
  matchesAny?: (string | number | boolean)[]
  size?: ComparisonFilter
}

export type PresenceFilter = {
  exists?: boolean
  notExists?: boolean
  isEmpty?: boolean
  isNotEmpty?: boolean
}

export type GeoRadiusFilter = {
  radius: {
    lat: number
    lon: number
    distance: number
    unit: 'km' | 'mi' | 'm'
    inside?: boolean
    highPrecision?: boolean
  }
}

export type GeoPolygonFilter = {
  polygon: {
    points: Array<{ lat: number; lon: number }>
    inside?: boolean
  }
}

export type GeoFilter = GeoRadiusFilter | GeoPolygonFilter

export type FieldFilter = ComparisonFilter | StringFilter | ArrayFilter | PresenceFilter | GeoFilter

export type FilterExpression = {
  fields?: Record<string, FieldFilter>
  and?: FilterExpression[]
  or?: FilterExpression[]
  not?: FilterExpression
}
