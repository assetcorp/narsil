import { PROTOTYPE_POLLUTION_KEYS } from '../schema/validator/shared'
import type { AnyDocument } from '../types/schema'
import type { DocumentProjection } from '../types/search'

export type ResolvedProjection =
  | { kind: 'full' }
  | { kind: 'none' }
  | { kind: 'fields'; include: string[][] | null; exclude: string[][] }

function splitPaths(paths: string[] | undefined): string[][] {
  if (!paths) return []
  const split: string[][] = []
  for (const path of paths) {
    const segments = path.split('.').filter(segment => segment.length > 0)
    if (segments.length === 0) continue
    if (segments.some(segment => PROTOTYPE_POLLUTION_KEYS.has(segment))) continue
    split.push(segments)
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

function readPath(source: Readonly<Record<string, unknown>>, path: string[]): { found: boolean; value: unknown } {
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

function cloneExcept(value: unknown, path: string[], exclude: string[][]): unknown {
  const reachesDeeper = exclude.some(excluded => excluded.length > path.length && covers(path, excluded))
  if (!reachesDeeper) return structuredClone(value)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return structuredClone(value)
  const source = value as Record<string, unknown>
  const kept: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    const childPath = [...path, key]
    if (exclude.some(excluded => covers(excluded, childPath))) continue
    kept[key] = cloneExcept(source[key], childPath, exclude)
  }
  return kept
}

/**
 * Reads what the caller set under `document` into the form the read path uses.
 *
 * @param projection - The caller's projection, which may be absent.
 * @returns The resolved projection, which is `full` where the caller set
 * nothing and where the shape they set covers every field.
 */
export function resolveProjection(projection: DocumentProjection | undefined): ResolvedProjection {
  if (projection === undefined || projection === true) return { kind: 'full' }
  if (projection === false) return { kind: 'none' }
  if (typeof projection !== 'object' || projection === null) return { kind: 'full' }
  const askedInclude = Array.isArray(projection.include) && projection.include.length > 0
  const askedExclude = Array.isArray(projection.exclude) && projection.exclude.length > 0
  if (!askedInclude && !askedExclude) return { kind: 'full' }
  return {
    kind: 'fields',
    include: askedInclude ? splitPaths(projection.include) : null,
    exclude: splitPaths(projection.exclude),
  }
}

/**
 * Answers whether the projection keeps a field, so the read path skips a
 * vector the caller dropped instead of reading it out of the vector index.
 *
 * @param projection - The resolved projection.
 * @param fieldPath - The dotted path of the field, as the schema names it.
 * @returns True where the projection keeps any part of the field.
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
 * Copies a stored document into the shape the projection keeps, and copies
 * nothing the projection drops. Where a query excludes a vector field, the
 * copy holds the other fields alone, so the cost of the read follows the size
 * of the fields the caller kept.
 *
 * @param document - The stored document, which this function never modifies.
 * @param projection - The resolved projection. Leave it out to copy every
 * field.
 * @returns A new document, sharing no reference with the stored one.
 */
export function cloneProjected(
  document: Readonly<Record<string, unknown>>,
  projection?: ResolvedProjection,
): AnyDocument {
  if (projection === undefined || projection.kind === 'full') return structuredClone(document) as AnyDocument
  if (projection.kind === 'none') return {}
  if (projection.include === null) return cloneExcept(document, [], projection.exclude) as AnyDocument

  const projected: Record<string, unknown> = {}
  for (const path of projection.include) {
    if (projection.exclude.some(excluded => covers(excluded, path))) continue
    const { found, value } = readPath(document, path)
    if (!found) continue
    writePath(projected, path, cloneExcept(value, path, projection.exclude))
  }
  return projected as AnyDocument
}

/**
 * Cuts a document the caller already holds down to what the projection keeps.
 * A cluster node uses this on a document another node sent it, because the
 * read that built that document ran on the other machine.
 *
 * @param document - The document, which this function never modifies.
 * @param projection - The resolved projection.
 * @returns The document itself where the projection keeps every field, and a
 * new object holding the kept fields otherwise.
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
