import type { HttpRequest, HttpResponse, TemplatedApp } from 'uWebSockets.js'
import { corsHeaderReader, type ResolvedCors, writeCorsOrigin } from '../cors'
import type { ResolvedLimits } from '../deps'
import { ServerErrorCodes } from '../errors'
import { type RouteHandler, type RouteOptions, sinkWritingAfterStatus } from '../request'
import { sendError } from '../response'
import type { ServerHandlers } from './spec'
import { serverRoutes } from './table'

export type RouteRunner = (
  handler: RouteHandler,
  options: RouteOptions,
) => (res: HttpResponse, req: HttpRequest) => void

export function registerServerRoutes(
  app: TemplatedApp,
  run: RouteRunner,
  handlers: ServerHandlers,
  limits: ResolvedLimits,
  cors: ResolvedCors | null,
): void {
  if (cors) {
    app.options('/*', (res, req) => {
      const origin = req.getHeader('origin')
      res.cork(() => {
        res.writeStatus('204 No Content')
        writeCorsOrigin(res, cors, origin)
        res
          .writeHeader('Access-Control-Allow-Methods', cors.methods)
          .writeHeader('Access-Control-Allow-Headers', cors.headers)
          .writeHeader('Access-Control-Max-Age', '86400')
          .endWithoutBody()
      })
    })
  }

  for (const route of serverRoutes(limits)) {
    app[route.method](route.path, run(handlers[route.handler], route.options))
  }

  const corsHeaders = cors ? corsHeaderReader(cors) : null
  app.any('/*', (res, req) => {
    const sink = corsHeaders === null ? res : sinkWritingAfterStatus(res, corsHeaders(req))
    sendError(sink, 404, ServerErrorCodes.NOT_FOUND, 'Route not found')
  })
}
