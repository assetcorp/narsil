import { ErrorCodes, NarsilError } from '../errors'
import { MAX_HYBRID_DEPTH, MIN_HYBRID_DEPTH } from './constants'

export function fixedHybridDepthOf(hybrid: { depth?: number | null } | null | undefined): number | undefined {
  const depth = hybrid?.depth
  if (depth === undefined || depth === null) return undefined
  if (!Number.isInteger(depth) || depth < MIN_HYBRID_DEPTH || depth > MAX_HYBRID_DEPTH) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `hybrid.depth must be a whole number from ${MIN_HYBRID_DEPTH} to ${MAX_HYBRID_DEPTH}`,
      { depth },
    )
  }
  return depth
}

export function requireWithinHybridDepth(cursorDepth: number, offset: number, depth: number): void {
  const start = cursorDepth + offset
  if (start < depth) return
  throw new NarsilError(
    ErrorCodes.SEARCH_RESULT_WINDOW_EXCEEDED,
    `A hybrid query pages through the first ${depth} fused results, and this page starts at ${start}. Raise hybrid.depth to page further`,
    { offset, cursorDepth, depth },
  )
}
