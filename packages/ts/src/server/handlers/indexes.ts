import { mapHttpIndexConfig } from '../config-mapping'
import type { HandlerDeps } from '../deps'
import { parseJson, rejectInvalid, respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import type { CreateIndexRequest } from '../types'
import { validateCreateIndex } from '../validation'

export function createIndexHandlers(deps: HandlerDeps) {
  const { engine } = deps

  async function create(ctx: RouteContext): Promise<void> {
    const body = parseJson<CreateIndexRequest>(ctx)
    if (!body) return
    const failure = validateCreateIndex(body)
    if (failure) {
      rejectInvalid(ctx, failure)
      return
    }
    try {
      const config = mapHttpIndexConfig(body.config)
      await engine.createIndex(body.name, config)
      respondJson(ctx, { name: body.name }, 201)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  function list(ctx: RouteContext): void {
    try {
      respondJson(ctx, { indexes: engine.listIndexes() })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function drop(ctx: RouteContext): Promise<void> {
    try {
      await engine.dropIndex(ctx.params[0])
      respondJson(ctx, { name: ctx.params[0], dropped: true })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  function stats(ctx: RouteContext): void {
    try {
      respondJson(ctx, engine.getStats(ctx.params[0]))
    } catch (err) {
      respondError(ctx, err)
    }
  }

  function partitions(ctx: RouteContext): void {
    try {
      respondJson(ctx, { partitions: engine.getPartitionStats(ctx.params[0]) })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function clear(ctx: RouteContext): Promise<void> {
    try {
      await engine.clear(ctx.params[0])
      respondJson(ctx, { name: ctx.params[0], cleared: true })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  return { create, list, drop, stats, partitions, clear }
}
