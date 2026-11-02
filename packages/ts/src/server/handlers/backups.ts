import { validateBackupName } from '../../distribution/backups/keys'
import { readRestorePlacement } from '../../distribution/backups/restore-options'
import type { BackupProgress } from '../../distribution/backups/types'
import { isRecord } from '../../distribution/payload-guards'
import type { HandlerDeps } from '../deps'
import { badRequest, parseJson, respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import type { TaskContext } from '../tasks'
import type { BackupListResponse, RestoreBackupBody } from '../types'
import { requireCluster } from './cluster'

function stepsOf(context: TaskContext): { onProgress: (progress: BackupProgress) => void } {
  return { onProgress: progress => context.reportSteps({ done: progress.done, total: progress.total }) }
}

function restoreOptionsOf(body: Record<string, unknown>): RestoreBackupBody | string {
  const { indexName } = body
  if (typeof indexName !== 'string') return 'The body must carry the new index name as a string in "indexName"'
  const placement = readRestorePlacement(body)
  return typeof placement === 'string' ? placement : { indexName, ...placement }
}

function readBody(ctx: RouteContext): Record<string, unknown> | undefined {
  const body = parseJson<unknown>(ctx)
  if (body === undefined) return undefined
  if (!isRecord(body)) {
    badRequest(ctx.res, 'The body must be a JSON object')
    return undefined
  }
  return body
}

export function createBackupHandlers(deps: HandlerDeps) {
  async function create(ctx: RouteContext): Promise<void> {
    try {
      const cluster = requireCluster(deps)
      const indexName = ctx.params[0] ?? ''
      const body = readBody(ctx)
      if (body === undefined) return
      if (typeof body.backup !== 'string') {
        badRequest(ctx.res, 'The body must carry the backup name as a string in "backup"', { indexName })
        return
      }
      const backupName = validateBackupName(body.backup)
      const record = await deps.tasks.start(
        'backup',
        indexName,
        async context => {
          await cluster.createBackup(indexName, backupName, stepsOf(context))
        },
        undefined,
        backupName,
      )
      respondJson(ctx, record, 202)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function list(ctx: RouteContext): Promise<void> {
    try {
      const cluster = requireCluster(deps)
      respondJson(ctx, { backups: await cluster.listBackups() } satisfies BackupListResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function restore(ctx: RouteContext): Promise<void> {
    try {
      const cluster = requireCluster(deps)
      const backupName = validateBackupName(ctx.params[0])
      const body = readBody(ctx)
      if (body === undefined) return
      const options = restoreOptionsOf(body)
      if (typeof options === 'string') {
        badRequest(ctx.res, options, { backupName })
        return
      }
      const record = await deps.tasks.start(
        'backupRestore',
        options.indexName,
        async context => {
          await cluster.restoreBackup(backupName, { ...options, ...stepsOf(context) })
        },
        undefined,
        backupName,
      )
      respondJson(ctx, record, 202)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function remove(ctx: RouteContext): Promise<void> {
    try {
      const cluster = requireCluster(deps)
      const backupName = validateBackupName(ctx.params[0])
      const record = await deps.tasks.start(
        'backupDelete',
        '',
        async context => {
          await cluster.deleteBackup(backupName, stepsOf(context))
        },
        undefined,
        backupName,
      )
      respondJson(ctx, record, 202)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  return { create, list, restore, remove }
}
