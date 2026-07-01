import { mapHttpIndexConfig } from '../config-mapping'
import type { HandlerDeps } from '../deps'
import { badRequest, parseJson, respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import type { CreateIndexRequest } from '../types'

export function createIndexHandlers(deps: HandlerDeps) {
  const { engine, adapters } = deps

  async function create(ctx: RouteContext): Promise<void> {
    const body = parseJson<CreateIndexRequest>(ctx)
    if (!body) return
    if (typeof body.name !== 'string' || body.name.length === 0) {
      badRequest(ctx.res, 'Field "name" is required and must be a non-empty string')
      return
    }
    if (typeof body.config !== 'object' || body.config === null) {
      badRequest(ctx.res, 'Field "config" is required and must be an object')
      return
    }
    try {
      const config = mapHttpIndexConfig(body.config, adapters)
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
