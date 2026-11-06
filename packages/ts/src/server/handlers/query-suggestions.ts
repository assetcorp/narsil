import { isRecord } from '../../distribution/payload-guards'
import { ErrorCodes, NarsilError } from '../../errors'
import { querySuggestions } from '../../query-suggestions'
import type { QuerySuggestions, QuerySuggestionsSetting, RecordQueryResult } from '../../types/query-suggestions'
import type { HandlerDeps } from '../deps'
import { ServerErrorCodes } from '../errors'
import { badRequest, parseJson, respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import { sendError } from '../response'
import type {
  ManualSuggestionResponse,
  OkResponse,
  QueryBansBody,
  QueryIdentity,
  RemoveQueryResponse,
  ServerQuerySuggestionsOptions,
} from '../types'

const PREVIEW_LIMIT_PATTERN = /^\d{1,7}$/

function readObject(ctx: RouteContext): Record<string, unknown> | undefined {
  const body = parseJson<unknown>(ctx)
  if (body === undefined) return undefined
  if (!isRecord(body)) {
    badRequest(ctx.res, 'The body must be a JSON object')
    return undefined
  }
  return body
}

function readQuery(ctx: RouteContext, body: Record<string, unknown>): string | undefined {
  if (typeof body.query === 'string') return body.query
  badRequest(ctx.res, 'The body must carry the phrase as a string in "query"')
  return undefined
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function isIdentity(value: unknown): value is QueryIdentity {
  return isRecord(value) && typeof value.person === 'string' && typeof value.group === 'string'
}

function previewLimitOf(raw: string | null): number | undefined | null {
  if (raw === null) return undefined
  return PREVIEW_LIMIT_PATTERN.test(raw) ? Number(raw) : null
}

async function identityOf(
  options: ServerQuerySuggestionsOptions,
  ctx: RouteContext,
): Promise<QueryIdentity | null | undefined> {
  if (ctx.hookContext === null) return undefined
  try {
    const identity = await options.identify(ctx.hookContext)
    if (identity === null) return null
    return isIdentity(identity) ? { person: identity.person, group: identity.group } : undefined
  } catch {
    return undefined
  }
}

function noIdentify(indexName: string): NarsilError {
  return new NarsilError(
    ErrorCodes.QUERY_SUGGESTIONS_NOT_ENABLED,
    'This server has no identify function for popular query suggestions, so it counts no search',
    { indexName },
  )
}

export function createQuerySuggestionHandlers(deps: HandlerDeps, options: ServerQuerySuggestionsOptions | undefined) {
  const { engine, tasks } = deps
  const suggestions = (): QuerySuggestions => querySuggestions(engine)

  async function update(ctx: RouteContext): Promise<void> {
    const body = parseJson<QuerySuggestionsSetting>(ctx)
    if (body === undefined) return
    try {
      await suggestions().updateSetting(ctx.params[0], body)
      respondJson(ctx, { ok: true } satisfies OkResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function status(ctx: RouteContext): Promise<void> {
    try {
      respondJson(ctx, await suggestions().status(ctx.params[0]))
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function record(ctx: RouteContext): Promise<void> {
    const body = readObject(ctx)
    if (body === undefined) return
    const extra = Object.keys(body).filter(key => key !== 'query')
    if (extra.length > 0) {
      badRequest(ctx.res, 'The body carries the search in "query" alone, because the server identifies the person', {
        fields: extra,
      })
      return
    }
    const query = readQuery(ctx, body)
    if (query === undefined) return
    const indexName = ctx.params[0]
    try {
      if (options === undefined) throw noIdentify(indexName)
      const identity = await identityOf(options, ctx)
      if (identity === undefined) {
        if (!ctx.abort.aborted) {
          sendError(ctx.res, 500, ServerErrorCodes.HOOK_ERROR, 'The identify function of query suggestions failed')
        }
        return
      }
      if (identity === null) {
        respondJson(ctx, { recorded: false, outcome: 'unidentified' } satisfies RecordQueryResult)
        return
      }
      respondJson(ctx, await suggestions().recordQuery(indexName, { query, ...identity }))
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function build(ctx: RouteContext): Promise<void> {
    const indexName = ctx.params[0]
    try {
      const operations = suggestions()
      const current = await operations.status(indexName)
      if (current.setting?.enabled !== true) {
        throw new NarsilError(
          ErrorCodes.QUERY_SUGGESTIONS_NOT_ENABLED,
          `Index "${indexName}" has popular query suggestions off`,
          { indexName },
        )
      }
      const task = await tasks.start('querySuggestionsBuild', indexName, async context => {
        const finished = await operations.build(indexName)
        context.reportBuild(finished)
        if (finished.status === 'failed') {
          throw new NarsilError(
            finished.errorCode ?? ErrorCodes.WORKER_ACTION_FAILED,
            'The build of popular query suggestions failed',
            { indexName, buildId: finished.buildId },
          )
        }
      })
      respondJson(ctx, task, 202)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function preview(ctx: RouteContext): Promise<void> {
    const limit = previewLimitOf(ctx.query.get('limit'))
    if (limit === null) {
      badRequest(ctx.res, 'Query parameter "limit" must be a whole number', { value: ctx.query.get('limit') })
      return
    }
    try {
      respondJson(ctx, await suggestions().preview(ctx.params[0], limit))
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function readBans(ctx: RouteContext): Promise<void> {
    try {
      respondJson(ctx, { bans: await suggestions().bans(ctx.params[0]) } satisfies QueryBansBody)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function replaceBans(ctx: RouteContext): Promise<void> {
    const body = readObject(ctx)
    if (body === undefined) return
    if (!isStringList(body.bans)) {
      badRequest(ctx.res, 'The body must carry the ban list as an array of strings in "bans"')
      return
    }
    try {
      respondJson(ctx, { bans: await suggestions().updateBans(ctx.params[0], body.bans) } satisfies QueryBansBody)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function remove(ctx: RouteContext): Promise<void> {
    const body = readObject(ctx)
    if (body === undefined) return
    const query = readQuery(ctx, body)
    if (query === undefined) return
    try {
      const held = await suggestions().removeQuery(ctx.params[0], query)
      respondJson(ctx, { suggestionIndexes: held } satisfies RemoveQueryResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function manual(ctx: RouteContext): Promise<void> {
    const body = readObject(ctx)
    if (body === undefined) return
    const query = readQuery(ctx, body)
    if (query === undefined) return
    const { group, count } = body
    if (typeof group !== 'string' || (count !== undefined && typeof count !== 'number')) {
      badRequest(ctx.res, 'The body must carry the group as a string in "group", and any count as a number in "count"')
      return
    }
    try {
      const name = await suggestions().addSuggestion(ctx.params[0], {
        group,
        query,
        ...(count === undefined ? {} : { count }),
      })
      respondJson(ctx, { indexName: name } satisfies ManualSuggestionResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  return { update, status, record, build, preview, readBans, replaceBans, remove, manual }
}
