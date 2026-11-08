import { PENDING_REMOVAL_MERGE_DIVISOR, PENDING_REMOVAL_MERGE_FLOOR } from '../core/constants'
import { codeLoader } from '../workers/code-loader'
import type * as GeoIndexModule from './geo-index'
import type { GeoIndex } from './geo-index'

export type GeoCode = typeof GeoIndexModule

const geoCode = codeLoader<GeoCode>(() => import('./geo-index'), 'geopoint')

export const loadGeoCode = geoCode.load
export const loadGeoCodeFor = geoCode.loadFor

export const matchGeoRegions: GeoCode['filterGeoRegions'] = (...parameters) =>
  geoCode.require().filterGeoRegions(...parameters)

export function createLoadedGeoIndex(): GeoIndex {
  return geoCode.require().createGeoIndex(PENDING_REMOVAL_MERGE_FLOOR, PENDING_REMOVAL_MERGE_DIVISOR)
}
