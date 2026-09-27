import type { HttpRequest } from 'uWebSockets.js'
import type { ResponseSink } from './response'
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

function corsOriginHeaders(cors: ResolvedCors, requestOrigin: string): Array<[string, string]> {
  const allowed = matchOrigin(cors, requestOrigin)
  const variesByOrigin = Array.isArray(cors.origin)
  if (!allowed) return variesByOrigin ? [['Vary', 'Origin']] : []
  if (!variesByOrigin) return [['Access-Control-Allow-Origin', allowed]]
  return [
    ['Access-Control-Allow-Origin', allowed],
    ['Vary', 'Origin'],
  ]
}

export function writeCorsOrigin(res: ResponseSink, cors: ResolvedCors, requestOrigin: string): void {
  for (const [key, value] of corsOriginHeaders(cors, requestOrigin)) res.writeHeader(key, value)
}

export function corsHeaderReader(cors: ResolvedCors): (req: HttpRequest) => Array<[string, string]> {
  return req => corsOriginHeaders(cors, req.getHeader('origin'))
}
