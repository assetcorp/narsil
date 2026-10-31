import { indexReadsOf } from '../../narsil/index-reads'
import { mapHttpIndexConfig } from '../config-mapping'
import type { HandlerDeps } from '../deps'
import { parseJson, rejectInvalid, respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import type {
  CreateIndexRequest,
  IndexClearedResponse,
  IndexCreatedResponse,
  IndexDroppedResponse,
  IndexListResponse,
  IndexPartitionsResponse,
  IndexStateResponse,
} from '../types'
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
      respondJson(ctx, { name: body.name } satisfies IndexCreatedResponse, 201)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function list(ctx: RouteContext): Promise<void> {
    try {
      respondJson(ctx, { indexes: await indexReadsOf(engine).listIndexes() } satisfies IndexListResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function drop(ctx: RouteContext): Promise<void> {
    try {
      await engine.dropIndex(ctx.params[0])
      respondJson(ctx, { name: ctx.params[0], dropped: true } satisfies IndexDroppedResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function stats(ctx: RouteContext): Promise<void> {
    try {
      respondJson(ctx, await indexReadsOf(engine).getStats(ctx.params[0]))
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function partitions(ctx: RouteContext): Promise<void> {
    try {
      respondJson(ctx, {
        partitions: await indexReadsOf(engine).getPartitionStats(ctx.params[0]),
      } satisfies IndexPartitionsResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function clear(ctx: RouteContext): Promise<void> {
    try {
      await engine.clear(ctx.params[0])
      respondJson(ctx, { name: ctx.params[0], cleared: true } satisfies IndexClearedResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function open(ctx: RouteContext): Promise<void> {
    try {
      await engine.open(ctx.params[0])
      respondJson(ctx, { name: ctx.params[0], state: 'open' } satisfies IndexStateResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function close(ctx: RouteContext): Promise<void> {
    try {
      await engine.close(ctx.params[0])
      respondJson(ctx, { name: ctx.params[0], state: 'closed' } satisfies IndexStateResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  return { create, list, drop, stats, partitions, clear, open, close }
}
