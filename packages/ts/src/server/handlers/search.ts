import type { QueryParams, SuggestParams } from '../../types/search'
import type { HandlerDeps } from '../deps'
import { badRequest, parseJson, respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'

function rejectsCustomReducer(ctx: RouteContext, params: QueryParams): boolean {
  if (params.group && typeof params.group === 'object' && 'reduce' in params.group) {
    badRequest(
      ctx.res,
      'Custom group reducers are not available over HTTP; use "group.fields" and "group.maxPerGroup" only',
    )
    return true
  }
  return false
}

function rejectsResultWindow(ctx: RouteContext, params: QueryParams, maxWindow: number): boolean {
  const overField = (label: string, value: unknown): boolean => {
    if (typeof value === 'number' && value > maxWindow) {
      badRequest(ctx.res, `Field "${label}" exceeds the maximum result window of ${maxWindow}`, {
        value,
        limit: maxWindow,
      })
      return true
    }
    return false
  }
  if (overField('limit', params.limit)) return true
  if (overField('offset', params.offset)) return true
  if (params.group && typeof params.group === 'object' && overField('group.maxPerGroup', params.group.maxPerGroup)) {
    return true
  }
  return false
}

export function createSearchHandlers(deps: HandlerDeps) {
  const { engine, limits } = deps

  async function search(ctx: RouteContext): Promise<void> {
    const params = parseJson<QueryParams>(ctx)
    if (!params) return
    if (rejectsCustomReducer(ctx, params)) return
    if (rejectsResultWindow(ctx, params, limits.maxResultWindow)) return
    try {
      respondJson(ctx, await engine.query(ctx.params[0], params))
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function preflight(ctx: RouteContext): Promise<void> {
    const params = parseJson<QueryParams>(ctx)
    if (!params) return
    if (rejectsCustomReducer(ctx, params)) return
    if (rejectsResultWindow(ctx, params, limits.maxResultWindow)) return
    try {
      respondJson(ctx, await engine.preflight(ctx.params[0], params))
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function suggest(ctx: RouteContext): Promise<void> {
    const params = parseJson<SuggestParams>(ctx)
    if (!params) return
    if (typeof params.prefix !== 'string') {
      badRequest(ctx.res, 'Field "prefix" is required and must be a string')
      return
    }
    try {
      respondJson(ctx, await engine.suggest(ctx.params[0], params))
    } catch (err) {
      respondError(ctx, err)
    }
  }

  return { search, preflight, suggest }
}
