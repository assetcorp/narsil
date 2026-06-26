import type { HttpRequest, HttpResponse } from 'uWebSockets.js'
import type { CorsOptions } from './types'

export interface ResolvedCors {
  origin: string | string[]
  methods: string
  headers: string
}

export function resolveCors(cors: boolean | CorsOptions | undefined): ResolvedCors | null {
  if (!cors) return null
  if (cors === true) {
    return { origin: '*', methods: 'GET, POST, PUT, PATCH, DELETE, OPTIONS', headers: 'Content-Type, Authorization' }
  }
  return {
    origin: cors.origin ?? '*',
    methods: cors.methods?.join(', ') ?? 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    headers: cors.headers?.join(', ') ?? 'Content-Type, Authorization',
  }
}

function matchOrigin(cors: ResolvedCors, requestOrigin: string): string | null {
  if (cors.origin === '*') return '*'
  if (typeof cors.origin === 'string') return cors.origin
  return cors.origin.includes(requestOrigin) ? requestOrigin : null
}

export function writeCorsOrigin(res: HttpResponse, cors: ResolvedCors, requestOrigin: string): void {
  const allowed = matchOrigin(cors, requestOrigin)
  if (!allowed) return
  res.writeHeader('Access-Control-Allow-Origin', allowed)
  if (allowed !== '*') res.writeHeader('Vary', 'Origin')
}

export function corsWriter(cors: ResolvedCors): (res: HttpResponse, req: HttpRequest) => void {
  return (res, req) => writeCorsOrigin(res, cors, req.getHeader('origin'))
}
