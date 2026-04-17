import { MAX_NESTING_DEPTH } from '../../schema/validator'
import type { SchemaDefinition } from '../../types/schema'

export interface SchemaDiffEntry {
  path: string
  expected: string
  actual: string
}

/**
 * Sourced from schema/validator.ts so the diff bound never drifts from the
 * engine's own nesting cap. The walk below enforces the cap defensively in
 * case a custom coordinator backend delivers a pathological or cyclic object;
 * returning a sentinel beats a stack overflow.
 */
const SCHEMA_DIFF_MAX_DEPTH = MAX_NESTING_DEPTH

const DEPTH_EXCEEDED_SENTINEL = 'depth-exceeded'

/**
 * Structural comparison of two schemas. Returns a list of differences by
 * field path (dot-separated for nested objects). Each entry carries only the
 * field TYPE, never the value, so the diff can be attached to an error without
 * leaking user data. Missing nested fields are reported as '(absent)'.
 */
export function diffSchemas(expected: SchemaDefinition, actual: SchemaDefinition): SchemaDiffEntry[] {
  const diffs: SchemaDiffEntry[] = []
  walk(expected, actual, '', diffs, 1)
  return diffs
}

function walk(
  expected: SchemaDefinition,
  actual: SchemaDefinition,
  prefix: string,
  diffs: SchemaDiffEntry[],
  depth: number,
): void {
  if (depth > SCHEMA_DIFF_MAX_DEPTH) {
    diffs.push({
      path: prefix === '' ? DEPTH_EXCEEDED_SENTINEL : prefix,
      expected: DEPTH_EXCEEDED_SENTINEL,
      actual: DEPTH_EXCEEDED_SENTINEL,
    })
    return
  }

  const expectedKeys = Object.keys(expected).sort()
  const actualKeys = new Set(Object.keys(actual))

  for (const key of expectedKeys) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    const expectedValue = expected[key]
    const actualValue = actual[key]

    if (!actualKeys.has(key)) {
      diffs.push({ path, expected: describe(expectedValue), actual: '(absent)' })
      continue
    }
    actualKeys.delete(key)

    const expectedIsObject = typeof expectedValue === 'object' && expectedValue !== null
    const actualIsObject = typeof actualValue === 'object' && actualValue !== null

    if (expectedIsObject !== actualIsObject) {
      diffs.push({ path, expected: describe(expectedValue), actual: describe(actualValue) })
      continue
    }

    if (expectedIsObject && actualIsObject) {
      walk(expectedValue as SchemaDefinition, actualValue as SchemaDefinition, path, diffs, depth + 1)
      continue
    }

    if (expectedValue !== actualValue) {
      diffs.push({ path, expected: String(expectedValue), actual: String(actualValue) })
    }
  }

  for (const extraKey of actualKeys) {
    const path = prefix === '' ? extraKey : `${prefix}.${extraKey}`
    diffs.push({ path, expected: '(absent)', actual: describe(actual[extraKey]) })
  }
}

function describe(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'object') {
    return 'object'
  }
  return String(value)
}
