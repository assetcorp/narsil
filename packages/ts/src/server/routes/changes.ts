import type { SharedRouteOptions } from './options'
import type { RouteSpec } from './spec'

export function changesRoutes(shared: SharedRouteOptions): RouteSpec[] {
  return [
    {
      method: 'get',
      path: '/indexes/:name/changes',
      handler: 'getChanges',
      options: shared.named,
      operationId: 'getChanges',
      summary: 'Report the change capture setting of an index and its epoch',
      tags: ['Changes'],
      request: null,
      responses: { 200: 'ChangesStatus' },
    },
    {
      method: 'put',
      path: '/indexes/:name/changes',
      handler: 'updateChanges',
      options: shared.namedBody,
      operationId: 'updateChanges',
      summary: 'Replace the change capture setting of an index',
      tags: ['Changes'],
      request: 'ChangesSetting',
      responses: { 200: 'OkResponse' },
    },
  ]
}
