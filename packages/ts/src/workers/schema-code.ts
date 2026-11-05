import { loadRadiusCodeFor } from '../geo/radius-code'
import { loadVectorCodeFor } from './vector-code'

export function loadSchemaCodeFor(schema: unknown): Promise<unknown> | null {
  const vectorCode = loadVectorCodeFor(schema)
  const radiusCode = loadRadiusCodeFor(schema)
  if (vectorCode === null) return radiusCode
  if (radiusCode === null) return vectorCode
  return Promise.all([vectorCode, radiusCode])
}
