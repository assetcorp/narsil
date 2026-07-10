import type { QueryParams, SuggestParams } from '../../types/search'
import type { HandlerDeps } from '../deps'
import { parseJson, rejectInvalid, respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import { validateQuery, validateSuggest } from '../validation'

export function createSearchHandlers(deps: HandlerDeps) {
  const { engine, limits } = deps

  async function search(ctx: RouteContext): Promise<void> {
    const params = parseJson<QueryParams>(ctx)
    if (!params) return
    const failure = validateQuery(params, limits.maxResultWindow)
    if (failure) {
      rejectInvalid(ctx, failure)
      return
    }
    try {
      respondJson(ctx, await engine.query(ctx.params[0], params))
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function preflight(ctx: RouteContext): Promise<void> {
    const params = parseJson<QueryParams>(ctx)
    if (!params) return
    const failure = validateQuery(params, limits.maxResultWindow)
    if (failure) {
      rejectInvalid(ctx, failure)
      return
    }
    try {
      respondJson(ctx, await engine.preflight(ctx.params[0], params))
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function suggest(ctx: RouteContext): Promise<void> {
    const params = parseJson<SuggestParams>(ctx)
    if (!params) return
    const failure = validateSuggest(params)
    if (failure) {
      rejectInvalid(ctx, failure)
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
