import type { ResolvedLimits } from '../deps'
import { backupRoutes } from './backups'
import { changesRoutes } from './changes'
import { documentRoutes, searchRoutes } from './documents'
import { indexRoutes } from './indexes'
import { infoRoutes } from './info'
import { maintenanceRoutes } from './maintenance'
import { sharedRouteOptions } from './options'
import { querySuggestionRoutes } from './query-suggestions'
import type { RouteSpec } from './spec'
import { syncRoutes } from './sync'

export function serverRoutes(limits: ResolvedLimits): RouteSpec[] {
  const shared = sharedRouteOptions(limits)
  return [
    ...infoRoutes(shared),
    ...indexRoutes(shared),
    ...documentRoutes(shared),
    ...searchRoutes(shared),
    ...maintenanceRoutes(shared),
    ...backupRoutes(shared),
    ...syncRoutes(shared),
    ...changesRoutes(shared),
    ...querySuggestionRoutes(shared),
  ]
}
