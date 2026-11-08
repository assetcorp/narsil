import { getNestedValue } from '../core/partition/utils'
import { flattenSchema } from '../schema/validator/schema'
import { VECTOR_PATTERN } from '../schema/validator/shared'
import type { SchemaDefinition } from '../types/schema'

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const FLOAT32_BYTES = 4

export function vectorFieldPathsOfSchema(schema: SchemaDefinition): Set<string> {
  const paths = new Set<string>()
  for (const [fieldPath, fieldType] of Object.entries(flattenSchema(schema))) {
    if (typeof fieldType === 'string' && VECTOR_PATTERN.test(fieldType)) paths.add(fieldPath)
  }
  return paths
}

export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  if (!path.includes('.')) {
    if (FORBIDDEN_KEYS.has(path)) {
      return
    }
    obj[path] = value
    return
  }

  const segments = path.split('.')
  let current: Record<string, unknown> = obj

  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]
    if (segment === undefined || FORBIDDEN_KEYS.has(segment)) {
      return
    }

    let next = current[segment]
    if (next === null || next === undefined || typeof next !== 'object') {
      next = {}
      current[segment] = next
    }

    current = next as Record<string, unknown>
  }

  const finalSegment = segments.at(-1)
  if (finalSegment === undefined || FORBIDDEN_KEYS.has(finalSegment)) {
    return
  }

  current[finalSegment] = value
}

export function restoreVectorFields(document: Record<string, unknown>, vectorFieldPaths: ReadonlySet<string>): void {
  for (const fieldPath of vectorFieldPaths) {
    const value = getNestedValue(document, fieldPath)
    if (value instanceof Uint8Array && !(value instanceof Float32Array)) {
      if (value.byteLength % FLOAT32_BYTES !== 0) {
        throw new Error(
          `Vector field "${fieldPath}" has invalid byte length ${value.byteLength} (must be divisible by 4)`,
        )
      }
      const elementCount = value.byteLength / FLOAT32_BYTES
      const float32 = new Float32Array(elementCount)
      const dataView = new DataView(value.buffer, value.byteOffset, value.byteLength)
      for (let i = 0; i < elementCount; i += 1) {
        float32[i] = dataView.getFloat32(i * FLOAT32_BYTES, true)
      }
      setNestedValue(document, fieldPath, float32)
    }
  }
}
