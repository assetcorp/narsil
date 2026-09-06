import type { HandlerDeps } from '../deps'
import { parseJson, rejectInvalid, respondError, respondJson, serializeBatchResult } from '../handler-utils'
import type { RouteContext } from '../request'
import type { BatchBody, DocumentBody, InsertBody } from '../types'
import { validateBatch, validateDocumentBody } from '../validation'
import { createDocumentReadHandlers } from './document-reads'

export function createDocumentHandlers(deps: HandlerDeps) {
  const { engine } = deps
  const reads = createDocumentReadHandlers(deps)

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
        await engine.update(name, id, body.document, body.options)
        respondJson(ctx, { id, created: false })
      } else {
        const created = await engine.insert(name, body.document, id, body.options)
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
      await engine.update(ctx.params[0], ctx.params[1], body.document, body.options)
      respondJson(ctx, { id: ctx.params[1] })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function remove(ctx: RouteContext): Promise<void> {
    try {
      await engine.remove(ctx.params[0], ctx.params[1], { wait: ctx.query.get('wait') === 'true' })
      respondJson(ctx, { id: ctx.params[1], removed: true })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function waitForWrites(ctx: RouteContext): Promise<void> {
    try {
      await engine.waitForWrites(ctx.params[0])
      respondJson(ctx, { ok: true })
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
        respondJson(
          ctx,
          serializeBatchResult(await engine.updateBatch(ctx.params[0], body.updates ?? [], body.options)),
        )
      } else if (action === 'delete') {
        respondJson(ctx, serializeBatchResult(await engine.removeBatch(ctx.params[0], body.docIds ?? [], body.options)))
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

  return { ...reads, insert, put, patch, remove, batch, waitForWrites }
}
