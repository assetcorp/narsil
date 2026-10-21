import { ErrorCodes, NarsilError } from '../errors'
import { MAX_FILTER_DEPTH } from '../filters/constants'
import { respondError } from './handler-utils'
import type { RouteContext } from './request'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function regexFieldIn(expression: unknown, depth: number): string | null {
  if (!isRecord(expression) || depth > MAX_FILTER_DEPTH) return null
  if (isRecord(expression.fields)) {
    for (const [fieldPath, filter] of Object.entries(expression.fields)) {
      if (isRecord(filter) && Object.hasOwn(filter, 'regex')) return fieldPath
    }
  }
  for (const nested of [expression.and, expression.or]) {
    if (!Array.isArray(nested)) continue
    for (const child of nested) {
      const found = regexFieldIn(child, depth + 1)
      if (found !== null) return found
    }
  }
  return regexFieldIn(expression.not, depth + 1)
}

function refusedRegex(filters: unknown, allowRegex: boolean): NarsilError | null {
  if (allowRegex) return null
  const fieldPath = regexFieldIn(filters, 0)
  if (fieldPath === null) return null
  return new NarsilError(
    ErrorCodes.SEARCH_INVALID_FILTER,
    `This server refuses every "regex" test, because its operator set the allowRegex server option to false. Test field "${fieldPath}" with "contains" or "wildcard"`,
    { fieldPath, operator: 'regex', option: 'allowRegex' },
  )
}

export function refuseRegex(ctx: RouteContext, filters: unknown, allowRegex: boolean): boolean {
  const refused = refusedRegex(filters, allowRegex)
  if (refused === null) return false
  respondError(ctx, refused)
  return true
}
