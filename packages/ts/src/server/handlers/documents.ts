import { ErrorCodes, NarsilError } from '../../errors'
import type { AnyDocument } from '../../types/schema'
import type { HandlerDeps } from '../deps'
import { parseJson, rejectInvalid, respondError, respondJson, serializeBatchResult } from '../handler-utils'
import type { RouteContext } from '../request'
import type { BatchBody, DocumentBody, InsertBody, MultiGetBody } from '../types'
import { validateBatch, validateDocumentBody, validateMultiGet } from '../validation'

export function createDocumentHandlers(deps: HandlerDeps) {
  const { engine, limits } = deps

  async function insert(ctx: RouteContext): Promise<void> {
    const body = parseJson<InsertBody>(ctx)
    if (!body) return
    const failure = validateDocumentBody(body)
    if (failure) {
      rejectInvalid(ctx, failure)
      return
    }
    try {
      const id = await engine.insert(ctx.params[0], body.document, body.id, body.options)
      respondJson(ctx, { id }, 201)
    } catch (err) {
      respondError(ctx, err)
    }
  }

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

  async function put(ctx: RouteContext): Promise<void> {
    const body = parseJson<DocumentBody>(ctx)
    if (!body) return
    const failure = validateDocumentBody(body)
    if (failure) {
      rejectInvalid(ctx, failure)
      return
    }
    const [name, id] = ctx.params
    try {
      if (await engine.has(name, id)) {
        await engine.update(name, id, body.document)
        respondJson(ctx, { id, created: false })
      } else {
        const created = await engine.insert(name, body.document, id)
        respondJson(ctx, { id: created, created: true }, 201)
      }
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function patch(ctx: RouteContext): Promise<void> {
    const body = parseJson<DocumentBody>(ctx)
    if (!body) return
    const failure = validateDocumentBody(body)
    if (failure) {
      rejectInvalid(ctx, failure)
      return
    }
    try {
      await engine.update(ctx.params[0], ctx.params[1], body.document)
      respondJson(ctx, { id: ctx.params[1] })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function remove(ctx: RouteContext): Promise<void> {
    try {
      await engine.remove(ctx.params[0], ctx.params[1])
      respondJson(ctx, { id: ctx.params[1], removed: true })
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

  async function batch(ctx: RouteContext): Promise<void> {
    const body = parseJson<BatchBody>(ctx)
    if (!body) return
    const failure = validateBatch(body)
    if (failure) {
      rejectInvalid(ctx, failure)
      return
    }
    const action = body.action ?? 'insert'
    try {
      if (action === 'update') {
        respondJson(ctx, serializeBatchResult(await engine.updateBatch(ctx.params[0], body.updates ?? [])))
      } else if (action === 'delete') {
        respondJson(ctx, serializeBatchResult(await engine.removeBatch(ctx.params[0], body.docIds ?? [])))
      } else {
        respondJson(
          ctx,
          serializeBatchResult(await engine.insertBatch(ctx.params[0], body.documents ?? [], body.options)),
        )
      }
    } catch (err) {
      respondError(ctx, err)
    }
  }

  return { insert, get, exists, put, patch, remove, count, multiGet, batch }
}

function indexDocNotFound(docId: string): NarsilError {
  return new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found`, { docId })
}
