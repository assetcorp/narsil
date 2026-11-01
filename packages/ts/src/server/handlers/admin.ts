import { createReadStream } from 'node:fs'
import { indexReadsOf } from '../../narsil/index-reads'
import type { BM25Params, PartitionConfig } from '../../types/schema'
import type { SynonymRule } from '../../types/synonyms'
import { SNAPSHOT_ARCHIVE_CONTENT_TYPE } from '../constants'
import type { HandlerDeps } from '../deps'
import { ServerErrorCodes } from '../errors'
import { badRequest, parseJson, parseJsonOptional, rejectInvalid, respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import { sendError, sendStream } from '../response'
import type {
  ChangeAnalysisBody,
  MemoryStatsResponse,
  OkResponse,
  RebalanceBody,
  SynonymSetBody,
  VectorFieldBody,
  VectorMaintenanceResponse,
} from '../types'
import { parseTaskListQuery, validateChangeAnalysis, validateRebalance } from '../validation'

export function createAdminHandlers(deps: HandlerDeps) {
  const { engine, tasks, limits } = deps

  async function checkpoint(ctx: RouteContext): Promise<void> {
    try {
      await engine.checkpoint(ctx.params[0])
      respondJson(ctx, { ok: true } satisfies OkResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function snapshot(ctx: RouteContext): Promise<void> {
    try {
      const archive = await engine.snapshot(ctx.params[0])
      if (ctx.abort.aborted) {
        await archive.cancel()
        return
      }
      await sendStream(ctx.res, ctx.abort, archive, [['Content-Type', SNAPSHOT_ARCHIVE_CONTENT_TYPE]])
    } catch (err) {
      respondError(ctx, err)
    }
  }

  function vectorMaintenance(ctx: RouteContext): void {
    try {
      respondJson(ctx, { fields: engine.vectorMaintenanceStatus(ctx.params[0]) } satisfies VectorMaintenanceResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function compact(ctx: RouteContext): Promise<void> {
    const body = parseJsonOptional<VectorFieldBody>(ctx)
    if (!body) return
    try {
      await engine.compactVectors(ctx.params[0], body.field)
      respondJson(ctx, { ok: true } satisfies OkResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function partitionConfig(ctx: RouteContext): Promise<void> {
    const body = parseJsonOptional<Partial<PartitionConfig>>(ctx)
    if (!body) return
    try {
      await engine.updatePartitionConfig(ctx.params[0], body)
      respondJson(ctx, { ok: true } satisfies OkResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function readSynonyms(ctx: RouteContext): Promise<void> {
    try {
      respondJson(ctx, { synonyms: await engine.getSynonyms(ctx.params[0]) } satisfies SynonymSetBody)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function replaceSynonyms(ctx: RouteContext): Promise<void> {
    const body = parseJson<unknown>(ctx)
    if (body === undefined) return
    if (body === null || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'synonyms')) {
      if (!ctx.abort.aborted) badRequest(ctx.res, 'Send the synonym set as { "synonyms": [ ...rules ] }')
      return
    }
    try {
      await engine.updateSynonyms(ctx.params[0], Reflect.get(body, 'synonyms') as SynonymRule[])
      respondJson(ctx, { ok: true } satisfies OkResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function updateBm25(ctx: RouteContext): Promise<void> {
    const body = parseJson<BM25Params>(ctx)
    if (body === undefined) return
    try {
      await engine.updateBM25(ctx.params[0], body)
      respondJson(ctx, { ok: true } satisfies OkResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function memory(ctx: RouteContext): Promise<void> {
    try {
      const stats = await engine.getMemoryStats()
      const response: MemoryStatsResponse = { ...stats, requestThreads: deps.requestThreadCount() }
      respondJson(ctx, response)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function requireIndexExists(name: string): Promise<void> {
    await indexReadsOf(engine).getStats(name)
  }

  async function optimize(ctx: RouteContext): Promise<void> {
    const body = parseJsonOptional<VectorFieldBody>(ctx)
    if (!body) return
    const name = ctx.params[0]
    try {
      await requireIndexExists(name)
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
      await requireIndexExists(name)
    } catch (err) {
      respondError(ctx, err)
      return
    }
    const record = await tasks.start('rebuildAnalysis', name, () => engine.rebuildAnalysis(name))
    respondJson(ctx, record, 202)
  }

  async function changeAnalysis(ctx: RouteContext): Promise<void> {
    const body = parseJsonOptional<ChangeAnalysisBody>(ctx)
    if (!body) return
    const failure = validateChangeAnalysis(body)
    if (failure) {
      rejectInvalid(ctx, failure)
      return
    }
    const name = ctx.params[0]
    try {
      await requireIndexExists(name)
    } catch (err) {
      respondError(ctx, err)
      return
    }
    const record = await tasks.start('changeAnalysis', name, () => engine.changeAnalysis(name, body))
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
      await requireIndexExists(name)
    } catch (err) {
      respondError(ctx, err)
      return
    }
    const record = await tasks.start('rebalance', name, () => engine.rebalance(name, target))
    respondJson(ctx, record, 202)
  }

  async function restore(ctx: RouteContext): Promise<void> {
    const spooled = ctx.spooledBody
    if (spooled === null || spooled.bytes === 0) {
      await spooled?.remove()
      sendError(ctx.res, 400, ServerErrorCodes.EMPTY_BODY, 'Request body is empty')
      return
    }
    const name = ctx.params[0]
    try {
      const record = await tasks.start('restore', name, async () => {
        try {
          await engine.restore(name, createReadStream(spooled.path))
        } finally {
          await spooled.remove()
        }
      })
      respondJson(ctx, record, 202)
    } catch (err) {
      await spooled.remove()
      respondError(ctx, err)
    }
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
    readSynonyms,
    replaceSynonyms,
    updateBm25,
    memory,
    optimize,
    rebalance,
    rebuildAnalysis,
    changeAnalysis,
    restore,
    getTask,
    listTasks,
    cancelTask,
  }
}
