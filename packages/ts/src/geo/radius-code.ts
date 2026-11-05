import { codeLoader } from '../workers/code-loader'
import type * as RadiusModule from './radius'

export type RadiusCode = typeof RadiusModule

const radiusCode = codeLoader<RadiusCode>(() => import('./radius'), 'geopoint')

export const requireLoadedRadiusCode = radiusCode.require
export const loadRadiusCode = radiusCode.load
export const loadRadiusCodeFor = radiusCode.loadFor
