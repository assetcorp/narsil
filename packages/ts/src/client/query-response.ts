import { ClientErrorCodes, NarsilError } from '../errors'
import { decodeScore } from '../score-encoding'
import type { QueryResult } from '../types/results'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(path: string): never {
  throw new NarsilError(ClientErrorCodes.CLIENT_INVALID_RESPONSE, 'The search response holds an invalid hit score', {
    route: path,
  })
}

function decodeHits(hits: unknown, path: string): void {
  if (!Array.isArray(hits)) invalid(path)
  for (const hit of hits) {
    if (!record(hit)) invalid(path)
    if (!Object.hasOwn(hit, 'score')) continue
    const score = decodeScore(hit.score)
    if (score === undefined) invalid(path)
    hit.score = score
  }
}

export function decodeQueryResult<T>(payload: unknown, path: string): QueryResult<T> {
  if (!record(payload)) invalid(path)
  decodeHits(payload.hits, path)
  if (payload.groups !== undefined) {
    if (!Array.isArray(payload.groups)) invalid(path)
    for (const group of payload.groups) {
      if (!record(group)) invalid(path)
      decodeHits(group.hits, path)
    }
  }
  return payload as unknown as QueryResult<T>
}
