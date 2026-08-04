import type { AnyDocument } from '../../types/schema'
import type { DocumentProjection } from '../../types/search'

export type ResolvedProjection =
  | { kind: 'full' }
  | { kind: 'none' }
  | { kind: 'fields'; include: string[][] | null; exclude: string[][] }

function splitPaths(paths: string[] | undefined): string[][] {
  if (!paths) return []
  const split: string[][] = []
  for (const path of paths) {
    const segments = path.split('.').filter(segment => segment.length > 0)
    if (segments.length > 0) split.push(segments)
  }
  return split
}

function overlaps(a: string[], b: string[]): boolean {
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function covers(outer: string[], inner: string[]): boolean {
  if (outer.length > inner.length) return false
  for (let i = 0; i < outer.length; i++) {
    if (outer[i] !== inner[i]) return false
  }
  return true
}

function readPath(source: Record<string, unknown>, path: string[]): { found: boolean; value: unknown } {
  let current: unknown = source
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current))
      return { found: false, value: undefined }
    const record = current as Record<string, unknown>
    if (!(segment in record)) return { found: false, value: undefined }
    current = record[segment]
  }
  return { found: true, value: current }
}

function writePath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current = target
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]
    const existing = current[segment]
    if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
      current = existing as Record<string, unknown>
      continue
    }
    const created: Record<string, unknown> = {}
    current[segment] = created
    current = created
  }
  current[path[path.length - 1]] = value
}

function omitPath(source: Record<string, unknown>, path: string[]): Record<string, unknown> {
  const segment = path[0]
  if (!(segment in source)) return source
  const copy: Record<string, unknown> = { ...source }
  if (path.length === 1) {
    delete copy[segment]
    return copy
  }
  const child = copy[segment]
  if (typeof child !== 'object' || child === null || Array.isArray(child)) return copy
  copy[segment] = omitPath(child as Record<string, unknown>, path.slice(1))
  return copy
}

/**
 * Reads the projection a query asked for into the shape the query path uses.
 *
 * @param projection - What the query set under `document`, which may be absent.
 * @returns The resolved projection, which is `full` when the query asked for
 * nothing and when it asked for a shape that keeps every field.
 */
export function resolveProjection(projection: DocumentProjection | undefined): ResolvedProjection {
  if (projection === undefined || projection === true) return { kind: 'full' }
  if (projection === false) return { kind: 'none' }
  if (typeof projection !== 'object' || projection === null) return { kind: 'full' }
  const include = splitPaths(projection.include)
  const exclude = splitPaths(projection.exclude)
  if (include.length === 0 && exclude.length === 0) return { kind: 'full' }
  return { kind: 'fields', include: include.length > 0 ? include : null, exclude }
}

/**
 * Answers whether a field survives the projection, which is what lets the
 * engine skip reading a vector it is about to drop.
 *
 * @param projection - The resolved projection.
 * @param fieldPath - The dotted path of the field, as the schema names it.
 * @returns True when any part of the field can reach the response.
 */
export function projectionKeepsField(projection: ResolvedProjection, fieldPath: string): boolean {
  if (projection.kind === 'full') return true
  if (projection.kind === 'none') return false
  const path = fieldPath.split('.').filter(segment => segment.length > 0)
  if (path.length === 0) return false
  if (projection.include && !projection.include.some(included => overlaps(included, path))) return false
  return !projection.exclude.some(excluded => covers(excluded, path))
}

/**
 * Cuts a stored document down to what the projection keeps.
 *
 * @param document - The stored document, which is never modified.
 * @param projection - The resolved projection.
 * @returns The document itself when everything survives, and a new object
 * carrying the kept fields otherwise.
 */
export function applyProjection(document: AnyDocument, projection: ResolvedProjection): AnyDocument {
  if (projection.kind === 'full') return document
  if (projection.kind === 'none') return {}

  let projected: Record<string, unknown>

  if (projection.include) {
    projected = {}
    for (const path of projection.include) {
      const { found, value } = readPath(document, path)
      if (found) writePath(projected, path, value)
    }
  } else {
    projected = document
  }
  for (const path of projection.exclude) {
    projected = omitPath(projected, path)
  }
  return projected as AnyDocument
}
