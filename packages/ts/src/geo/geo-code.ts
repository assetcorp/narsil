import { codeLoader } from '../workers/code-loader'
import type * as GeoIndexModule from './geo-index'
import type { GeoIndex } from './geo-index'

export type GeoCode = typeof GeoIndexModule

const geoCode = codeLoader<GeoCode>(() => import('./geo-index'), 'geopoint')

export const loadGeoCode = geoCode.load
export const loadGeoCodeFor = geoCode.loadFor

export function createLoadedGeoIndex(): GeoIndex {
  return geoCode.require().createGeoIndex()
}
