import { SNAPSHOT_ARCHIVE_CONTENT_TYPE } from '../constants'
import { SYNC_SNAPSHOT_REQUEST_HEADERS } from '../sync/snapshot-handler'
import type { SharedRouteOptions } from './options'
import type { RouteSpec } from './spec'

export function syncRoutes(shared: SharedRouteOptions): RouteSpec[] {
  return [
    {
      method: 'get',
      path: '/indexes/:name/sync',
      handler: 'getSync',
      options: shared.named,
      operationId: 'getSync',
      summary: 'Report the device sync setting of an index, whether a device has downloaded it, and its epoch',
      tags: ['Sync'],
      request: null,
      responses: { 200: 'SyncStatus' },
    },
    {
      method: 'put',
      path: '/indexes/:name/sync',
      handler: 'updateSync',
      options: shared.namedBody,
      operationId: 'updateSync',
      summary: 'Replace the device sync setting of an index',
      tags: ['Sync'],
      request: 'SyncSetting',
      responses: { 200: 'OkResponse' },
    },
    {
      method: 'get',
      path: '/indexes/:name/sync/snapshot',
      handler: 'syncSnapshot',
      options: { ...shared.named, headers: SYNC_SNAPSHOT_REQUEST_HEADERS },
      operationId: 'syncSnapshot',
      summary: 'Download the published snapshot of an index with device sync on, whole or as one byte range',
      tags: ['Sync'],
      request: null,
      responses: {
        200: { contentType: SNAPSHOT_ARCHIVE_CONTENT_TYPE },
        206: { contentType: SNAPSHOT_ARCHIVE_CONTENT_TYPE },
      },
    },
  ]
}
