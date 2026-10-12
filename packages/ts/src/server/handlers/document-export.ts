import { createReadStream } from 'node:fs'
import type { DocumentImportResult } from '../../types/results'
import { DOCUMENT_EXPORT_CONTENT_TYPE } from '../constants'
import type { HandlerDeps } from '../deps'
import { ServerErrorCodes } from '../errors'
import { respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import { sendError, sendStream } from '../response'
import type { ImportResult } from '../types'

function importResultOf(result: DocumentImportResult, maxErrors: number): ImportResult {
  const errors = result.refused.slice(0, maxErrors)
  return {
    indexed: result.imported,
    failed: result.refusedCount,
    errors,
    errorsTruncated: result.refusedCount > errors.length,
  }
}

export function createDocumentExportHandlers(deps: HandlerDeps) {
  const { engine, tasks, limits } = deps

  async function exportDocuments(ctx: RouteContext): Promise<void> {
    try {
      const lines = await engine.exportDocuments(ctx.params[0])
      if (ctx.abort.aborted) {
        await lines.cancel()
        return
      }
      await sendStream(ctx.res, ctx.abort, lines, [['Content-Type', DOCUMENT_EXPORT_CONTENT_TYPE]])
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function importExport(ctx: RouteContext): Promise<void> {
    const spooled = ctx.spooledBody
    if (spooled === null || spooled.bytes === 0) {
      await spooled?.remove()
      sendError(ctx.res, 400, ServerErrorCodes.EMPTY_BODY, 'Request body is empty')
      return
    }
    const name = ctx.params[0]
    try {
      const record = await tasks.start('importExport', name, async context => {
        try {
          const result = await engine.importDocumentExport(name, createReadStream(spooled.path))
          context.reportResult(importResultOf(result, limits.maxImportErrors))
        } finally {
          await spooled.remove()
        }
      })
      respondJson(ctx, record, 202)
    } catch (err) {
      await spooled.remove()
      respondError(ctx, err)
    }
  }

  return { exportDocuments, importExport }
}
