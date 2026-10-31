import { bm25SetsValue } from '../../../core/scorer'
import { ErrorCodes } from '../../../errors'
import { validateBM25Params } from '../../../search/bm25-params'
import type { BM25Params } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import type { WireQueryParams } from '../../transport/types'
import type { HeldBm25Setting } from '../bm25-view'
import { localParamsToWire } from '../query-conversion'
import type { ClusterReadDeps } from './scatter'

export interface Bm25Routing {
  wireParams: WireQueryParams
  indexBm25: BM25Params | undefined
  carriesBm25: boolean
}

function routingUnder(params: QueryParams, setting: HeldBm25Setting | null): Bm25Routing {
  const wireParams = localParamsToWire(params)
  if (setting === null) return { wireParams, indexBm25: undefined, carriesBm25: bm25SetsValue(params.bm25) }
  const indexBm25 = setting.bm25 ?? {}
  wireParams.indexBm25 = indexBm25
  return { wireParams, indexBm25, carriesBm25: setting.revision !== undefined || bm25SetsValue(params.bm25) }
}

export function heldBm25RoutingFor(
  deps: ClusterReadDeps,
  settingName: string,
  params: QueryParams,
): Bm25Routing | undefined {
  if (params.bm25 !== undefined) return undefined
  const setting = deps.bm25View.held(settingName)
  return setting === undefined ? undefined : routingUnder(params, setting)
}

export async function bm25RoutingFor(
  deps: ClusterReadDeps,
  settingName: string,
  params: QueryParams,
): Promise<Bm25Routing> {
  if (params.bm25 !== undefined) {
    const schema = await deps.config.coordinator.getSchema(settingName)
    if (schema !== null) validateBM25Params(params.bm25, schema, ErrorCodes.SEARCH_INVALID_FIELD)
  }
  return routingUnder(params, await deps.bm25View.current(settingName))
}
