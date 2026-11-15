import type { QueryParams } from '../types/search'
import { parseJsonObject, rejectInvalid } from './handler-utils'
import type { ParsedBodyKind } from './parse-heap'
import { checkQueryShape } from './query-shape'
import { refuseRegex } from './regex-policy'
import type { RouteContext } from './request'
import { type QueryLimits, validateQuery } from './validation'

export function readQueryBody(
  ctx: RouteContext,
  limits: QueryLimits,
  allowRegex: boolean,
  kind: ParsedBodyKind = 'write',
): QueryParams | undefined {
  const parsed = parseJsonObject<QueryParams>(ctx, kind)
  if (!parsed) return undefined
  const shaped = checkQueryShape(parsed)
  if ('failure' in shaped) {
    rejectInvalid(ctx, shaped.failure)
    return undefined
  }
  const failure = validateQuery(shaped.query, limits)
  if (failure) {
    rejectInvalid(ctx, failure)
    return undefined
  }
  if (refuseRegex(ctx, shaped.query.filters, allowRegex)) return undefined
  return shaped.query
}
