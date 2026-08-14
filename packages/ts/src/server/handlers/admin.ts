import type { PartitionConfig } from '../../types/schema'
import type { HandlerDeps } from '../deps'
import { ServerErrorCodes } from '../errors'
import { parseJsonOptional, rejectInvalid, respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import { sendBinary, sendError } from '../response'
import type { RebalanceBody } from '../types'
import { parseTaskListQuery, validateRebalance } from '../validation'

interface FieldBody {
  field?: string
}

export function createAdminHandlers(deps: HandlerDeps) {
  const { engine, tasks, limits } = deps

  async function checkpoint(ctx: RouteContext): Promise<void> {
    try {
      await engine.checkpoint(ctx.params[0])
      respondJson(ctx, { ok: true })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function snapshot(ctx: RouteContext): Promise<void> {
    try {
      const bytes = await engine.snapshot(ctx.params[0])
      if (ctx.abort.aborted) return
      sendBinary(ctx.res, bytes, ctx.abort)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  function vectorMaintenance(ctx: RouteContext): void {
    try {
      respondJson(ctx, { fields: engine.vectorMaintenanceStatus(ctx.params[0]) })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function compact(ctx: RouteContext): Promise<void> {
    const body = parseJsonOptional<FieldBody>(ctx)
    if (!body) return
    try {
      await engine.compactVectors(ctx.params[0], body.field)
      respondJson(ctx, { ok: true })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function partitionConfig(ctx: RouteContext): Promise<void> {
    const body = parseJsonOptional<Partial<PartitionConfig>>(ctx)
    if (!body) return
    try {
      await engine.updatePartitionConfig(ctx.params[0], body)
      respondJson(ctx, { ok: true })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function memory(ctx: RouteContext): Promise<void> {
    try {
      respondJson(ctx, await engine.getMemoryStats())
    } catch (err) {
      respondError(ctx, err)
    }
  }

  function requireIndexExists(name: string): void {
    engine.getStats(name)
  }

  async function optimize(ctx: RouteContext): Promise<void> {
    const body = parseJsonOptional<FieldBody>(ctx)
    if (!body) return
    const name = ctx.params[0]
    try {
      requireIndexExists(name)
    } catch (err) {
      respondError(ctx, err)
      return
    }
    const record = await tasks.start('optimizeVectors', name, () => engine.optimizeVectors(name, body.field))
    respondJson(ctx, record, 202)
  }

  async function rebuildAnalysis(ctx: RouteContext): Promise<void> {
    const name = ctx.params[0]
    try {
      requireIndexExists(name)
    } catch (err) {
      respondError(ctx, err)
      return
    }
    const record = await tasks.start('rebuildAnalysis', name, () => engine.rebuildAnalysis(name))
    respondJson(ctx, record, 202)
  }

  async function rebalance(ctx: RouteContext): Promise<void> {
    const body = parseJsonOptional<RebalanceBody>(ctx)
    if (!body) return
    const failure = validateRebalance(body)
    if (failure) {
      rejectInvalid(ctx, failure)
      return
    }
    const target = body.targetPartitionCount as number
    const name = ctx.params[0]
    try {
      requireIndexExists(name)
    } catch (err) {
      respondError(ctx, err)
      return
    }
    const record = await tasks.start('rebalance', name, () => engine.rebalance(name, target))
    respondJson(ctx, record, 202)
  }

  async function restore(ctx: RouteContext): Promise<void> {
    const raw = ctx.rawBody
    if (!raw || raw.length === 0) {
      sendError(ctx.res, 400, ServerErrorCodes.EMPTY_BODY, 'Request body is empty')
      return
    }
    const name = ctx.params[0]
    const bytes = new Uint8Array(raw)
    const record = await tasks.start('restore', name, () => engine.restore(name, bytes))
    respondJson(ctx, record, 202)
  }

  async function getTask(ctx: RouteContext): Promise<void> {
    const record = await tasks.get(ctx.params[0])
    if (!record) {
      sendError(ctx.res, 404, ServerErrorCodes.TASK_NOT_FOUND, `Task "${ctx.params[0]}" not found`)
      return
    }
    respondJson(ctx, record)
  }

  async function listTasks(ctx: RouteContext): Promise<void> {
    const parsed = parseTaskListQuery(ctx.query, limits.maxTaskPageSize)
    if ('failure' in parsed) {
      rejectInvalid(ctx, parsed.failure)
      return
    }
    respondJson(ctx, await tasks.list(parsed.query))
  }

  async function cancelTask(ctx: RouteContext): Promise<void> {
    const taskId = ctx.params[0]
    const { outcome, record } = await tasks.cancel(taskId)
    if (outcome === 'not-found') {
      sendError(ctx.res, 404, ServerErrorCodes.TASK_NOT_FOUND, `Task "${taskId}" not found`)
      return
    }
    if (outcome === 'already-finished') {
      sendError(
        ctx.res,
        409,
        ServerErrorCodes.TASK_NOT_CANCELLABLE,
        `Task "${taskId}" has already finished`,
        record === null ? undefined : { status: record.status },
      )
      return
    }
    if (outcome === 'owned-by-another-instance') {
      sendError(
        ctx.res,
        409,
        ServerErrorCodes.TASK_OWNED_BY_ANOTHER_INSTANCE,
        `Task "${taskId}" runs on another server instance, which is the only one that can stop it`,
        record === null ? undefined : { owner: record.owner },
      )
      return
    }
    respondJson(ctx, record, 202)
  }

  return {
    checkpoint,
    snapshot,
    vectorMaintenance,
    compact,
    partitionConfig,
    memory,
    optimize,
    rebalance,
    rebuildAnalysis,
    restore,
    getTask,
    listTasks,
    cancelTask,
  }
}
