import { loadOptionalReadsFor } from '../engine/optional-reads-code'
import { loadGeoCodeFor } from '../geo/geo-code'
import { loadVectorCodeFor } from './vector-code'

export function loadSchemaCodeFor(schema: unknown): Promise<unknown> | null {
  const loading: Promise<unknown>[] = []
  for (const code of [loadVectorCodeFor(schema), loadGeoCodeFor(schema), loadOptionalReadsFor(schema)]) {
    if (code !== null) loading.push(code)
  }
  if (loading.length === 0) return null
  return loading.length === 1 ? loading[0] : Promise.all(loading)
}
