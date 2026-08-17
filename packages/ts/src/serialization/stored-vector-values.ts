import { VECTOR_PATTERN } from '../schema/validator/shared'
import type { SerializablePartition } from '../types/internal'

/**
 * Removes any vector value a partition payload stored beside its other document fields.
 *
 * A vector belongs to its own vector index payload, so a reader drops the copy an older
 * writer left in the documents rather than holding it in memory for the life of the index.
 *
 * @param documents - The documents the payload decoded, edited in place.
 * @param schema - The flat schema the payload carries, which names each vector field.
 */
export function dropStoredVectorValues(
  documents: SerializablePartition['documents'],
  schema: Record<string, string>,
): void {
  const vectorFieldPaths: string[] = []
  for (const [fieldPath, fieldType] of Object.entries(schema)) {
    if (typeof fieldType === 'string' && VECTOR_PATTERN.test(fieldType)) {
      vectorFieldPaths.push(fieldPath)
    }
  }
  if (vectorFieldPaths.length === 0) {
    return
  }

  for (const document of Object.values(documents)) {
    for (const fieldPath of vectorFieldPaths) {
      removeFieldAtPath(document.fields, fieldPath)
    }
  }
}

function removeFieldAtPath(fields: Record<string, unknown>, fieldPath: string): void {
  if (!fieldPath.includes('.')) {
    delete fields[fieldPath]
    return
  }

  const segments = fieldPath.split('.')
  let current: Record<string, unknown> = fields
  for (let i = 0; i < segments.length - 1; i += 1) {
    const next = current[segments[i]]
    if (next === null || typeof next !== 'object') {
      return
    }
    current = next as Record<string, unknown>
  }
  delete current[segments[segments.length - 1]]
}
