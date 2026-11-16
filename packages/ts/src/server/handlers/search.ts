import { bindQuerySignal, clearQuerySignal } from '../../narsil/internals'
import type { QueryParams, SuggestParams } from '../../types/search'
import { respondAnswer } from '../answer-stream'
import { parseJsonObject, rejectInvalid, respondError, respondJson } from '../handler-utils'
import { readQueryBody } from '../query-body'
import { encodeQueryResult } from '../query-response'
import type { RouteContext } from '../request'
import { requestSignal } from '../request-signal'
import { validateSuggest, withServerQueryLimits } from '../validation'
import type { ReadHandlerDeps } from './document-reads'

export function createSearchHandlers(deps: ReadHandlerDeps) {
  const { engine, limits, allowRegex } = deps

  async function search(ctx: RouteContext): Promise<void> {
    const params = readQueryBody(ctx, limits, allowRegex, 'read')
    if (!params) return
    try {
      const query = withServerQueryLimits(params, limits)
      const result = await searchWithSignal(ctx, query)
      await respondAnswer(ctx, encodeQueryResult(result), 'hits', `a search on index '${ctx.params[0]}'`)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function searchWithSignal(ctx: RouteContext, params: QueryParams) {
    bindQuerySignal(params, requestSignal(ctx.abort))
    try {
      return await engine.query(ctx.params[0], params)
    } finally {
      clearQuerySignal(params)
    }
  }

  async function preflight(ctx: RouteContext): Promise<void> {
    const params = readQueryBody(ctx, limits, allowRegex, 'read')
    if (!params) return
    try {
      const query = withServerQueryLimits(params, limits)
      bindQuerySignal(query, requestSignal(ctx.abort))
      try {
        respondJson(ctx, await engine.preflight(ctx.params[0], query))
      } finally {
        clearQuerySignal(query)
      }
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function suggest(ctx: RouteContext): Promise<void> {
    const params = parseJsonObject<SuggestParams>(ctx, 'read')
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
