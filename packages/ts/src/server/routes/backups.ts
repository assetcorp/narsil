import type { SharedRouteOptions } from './options'
import type { RouteSpec } from './spec'

export function backupRoutes(shared: SharedRouteOptions): RouteSpec[] {
  const { bare, named, namedBody } = shared
  return [
    {
      method: 'post',
      path: '/indexes/:name/backups',
      handler: 'createBackup',
      options: namedBody,
      operationId: 'createBackup',
      summary: 'Back up an index to the store outside the cluster, as a task',
      tags: ['Cluster'],
      request: 'CreateBackupBody',
      responses: { 202: 'TaskRecord' },
    },
    {
      method: 'get',
      path: '/backups',
      handler: 'listBackups',
      options: bare,
      operationId: 'listBackups',
      summary: 'List the backups in the store outside the cluster',
      tags: ['Cluster'],
      request: null,
      responses: { 200: 'BackupListResponse' },
    },
    {
      method: 'post',
      path: '/backups/:backup/_restore',
      handler: 'restoreBackup',
      options: namedBody,
      operationId: 'restoreBackup',
      summary: 'Restore a backup as a new index, as a task',
      tags: ['Cluster'],
      request: 'RestoreBackupBody',
      responses: { 202: 'TaskRecord' },
    },
    {
      method: 'del',
      path: '/backups/:backup',
      handler: 'deleteBackup',
      options: named,
      operationId: 'deleteBackup',
      summary: 'Delete a backup and the files that no other backup lists, as a task',
      tags: ['Cluster'],
      request: null,
      responses: { 202: 'TaskRecord' },
    },
  ]
}
