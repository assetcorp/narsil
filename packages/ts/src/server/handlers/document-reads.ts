import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import type { AnyDocument } from '../../types/schema'
import type { ListParams } from '../../types/search'
import type { ResolvedLimits } from '../deps'
import { parseJson, rejectInvalid, respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import type { MultiGetBody } from '../types'
import { validateList, validateMultiGet } from '../validation'

/**
 * The engine methods the read routes call, which a request thread satisfies
 * from its own copy of an index.
 *
 * @internal
 */
export type ReadEngine = Pick<
  Narsil,
  'query' | 'preflight' | 'suggest' | 'get' | 'getMultiple' | 'has' | 'countDocuments' | 'listDocuments'
>

export interface ReadHandlerDeps {
  engine: ReadEngine
  limits: ResolvedLimits
}

export function createDocumentReadHandlers(deps: ReadHandlerDeps) {
  const { engine, limits } = deps

  async function get(ctx: RouteContext): Promise<void> {
    try {
      const document = await engine.get(ctx.params[0], ctx.params[1])
      if (document === undefined) {
        respondError(ctx, indexDocNotFound(ctx.params[1]))
        return
      }
      respondJson(ctx, { document })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function exists(ctx: RouteContext): Promise<void> {
    try {
      respondJson(ctx, { exists: await engine.has(ctx.params[0], ctx.params[1]) })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function count(ctx: RouteContext): Promise<void> {
    try {
      respondJson(ctx, { count: await engine.countDocuments(ctx.params[0]) })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function multiGet(ctx: RouteContext): Promise<void> {
    const body = parseJson<MultiGetBody>(ctx)
    if (!body) return
    const failure = validateMultiGet(body, limits.maxFetchDocuments)
    if (failure) {
      rejectInvalid(ctx, failure)
      return
    }
    try {
      const found = await engine.getMultiple(ctx.params[0], body.docIds)
      const documents: Record<string, AnyDocument> = {}
      for (const [id, doc] of found) documents[id] = doc
      respondJson(ctx, { documents })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function list(ctx: RouteContext): Promise<void> {
    const params = parseJson<ListParams>(ctx)
    if (!params) return
    const failure = validateList(params, limits.maxFetchDocuments)
    if (failure) {
      rejectInvalid(ctx, failure)
      return
    }
    try {
      respondJson(ctx, await engine.listDocuments(ctx.params[0], params))
    } catch (err) {
      respondError(ctx, err)
    }
  }

  return { get, exists, count, multiGet, list }
}

function indexDocNotFound(docId: string): NarsilError {
  return new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found`, { docId })
}
