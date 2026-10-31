import { bm25SetsValue } from '../../../core/scorer'
import { ErrorCodes } from '../../../errors'
import { validateBM25Params } from '../../../search/bm25-params'
import type { BM25Params } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import type { WireQueryParams } from '../../transport/types'
import { localParamsToWire } from '../query-conversion'
import type { ClusterReadDeps } from './scatter'

export interface Bm25Routing {
  wireParams: WireQueryParams
  indexBm25: BM25Params | undefined
  carriesBm25: boolean
}

export async function bm25RoutingFor(
  deps: ClusterReadDeps,
  indexName: string,
  params: QueryParams,
): Promise<Bm25Routing> {
  const settingName = deps.publicIndexName ?? indexName
  if (params.bm25 !== undefined) {
    const schema = await deps.config.coordinator.getSchema(settingName)
    if (schema !== null) validateBM25Params(params.bm25, schema, ErrorCodes.SEARCH_INVALID_FIELD)
  }
  const wire = localParamsToWire(params)
  const setting = await deps.bm25View.current(settingName)
  if (setting === null) {
    return { wireParams: wire, indexBm25: undefined, carriesBm25: bm25SetsValue(params.bm25) }
  }
  const indexBm25 = setting.bm25 ?? {}
  return {
    wireParams: { ...wire, indexBm25 },
    indexBm25,
    carriesBm25: setting.revision !== undefined || bm25SetsValue(params.bm25),
  }
}
