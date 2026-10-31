import type { ResolvedLimits } from '../deps'
import { documentRoutes, searchRoutes } from './documents'
import { indexRoutes } from './indexes'
import { infoRoutes } from './info'
import { maintenanceRoutes } from './maintenance'
import { sharedRouteOptions } from './options'
import type { RouteSpec } from './spec'

export function serverRoutes(limits: ResolvedLimits): RouteSpec[] {
  const shared = sharedRouteOptions(limits)
  return [
    ...infoRoutes(shared),
    ...indexRoutes(shared),
    ...documentRoutes(shared),
    ...searchRoutes(shared),
    ...maintenanceRoutes(shared),
  ]
}
