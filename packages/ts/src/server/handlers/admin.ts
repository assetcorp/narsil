import type { PartitionConfig } from '../../types/schema'
import type { HandlerDeps } from '../deps'
import { ServerErrorCodes } from '../errors'
import { parseJsonOptional, rejectInvalid, respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import { sendBinary, sendError } from '../response'
import type { RebalanceBody, TaskRecord } from '../types'
import { validateRebalance } from '../validation'

interface FieldBody {
  field?: string
}

function taskResponse(record: TaskRecord): { taskId: string; type: string; status: string } {
  return { taskId: record.id, type: record.type, status: record.status }
}

export function createAdminHandlers(deps: HandlerDeps) {
  const { engine, tasks } = deps

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
    respondJson(ctx, taskResponse(record), 202)
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
    respondJson(ctx, taskResponse(record), 202)
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
    respondJson(ctx, taskResponse(record), 202)
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
    respondJson(ctx, { tasks: await tasks.list() })
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
    restore,
    getTask,
    listTasks,
  }
}
