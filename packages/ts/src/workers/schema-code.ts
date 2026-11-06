import { loadGeoCodeFor } from '../geo/geo-code'
import { loadVectorCodeFor } from './vector-code'

export function loadSchemaCodeFor(schema: unknown): Promise<unknown> | null {
  const vectorCode = loadVectorCodeFor(schema)
  const geoCode = loadGeoCodeFor(schema)
  if (vectorCode === null) return geoCode
  if (geoCode === null) return vectorCode
  return Promise.all([vectorCode, geoCode])
}
