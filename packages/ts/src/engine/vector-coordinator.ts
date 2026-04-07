import { getNestedValue } from '../core/partition/utils'
import { ErrorCodes, NarsilError } from '../errors'
import type { VectorIndex } from '../vector/vector-index'

export function extractVectorFromDoc(document: Record<string, unknown>, fieldPath: string): Float32Array | null {
  const value = getNestedValue(document, fieldPath)
  if (value === undefined || value === null) return null
  if (value instanceof Float32Array) return value
  if (!Array.isArray(value)) return null
  const arr = new Float32Array(value.length)
  for (let i = 0; i < value.length; i++) {
    const n = value[i]
    if (typeof n !== 'number' || !Number.isFinite(n)) return null
    arr[i] = n
  }
  return arr
}

export function deleteNestedValue(obj: Record<string, unknown>, path: string): void {
  if (!path.includes('.')) {
    delete obj[path]
    return
  }
  const segments = path.split('.')
  let current: Record<string, unknown> = obj
  for (let i = 0; i < segments.length - 1; i++) {
    const next = current[segments[i]]
    if (next === null || next === undefined || typeof next !== 'object') return
    current = next as Record<string, unknown>
  }
  delete current[segments[segments.length - 1]]
}

export function vectorsEqual(a: Float32Array | null, b: Float32Array): boolean {
  if (!a) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function validateVectorDimensions(
  vectors: Map<string, Float32Array>,
  vecIndexes: Map<string, VectorIndex>,
): void {
  for (const [fieldPath, vector] of vectors) {
    const vecIndex = vecIndexes.get(fieldPath)
    if (!vecIndex) continue
    if (vector.length !== vecIndex.dimension) {
      throw new NarsilError(
        ErrorCodes.VECTOR_DIMENSION_MISMATCH,
        `Vector dimension mismatch for field "${fieldPath}": expected ${vecIndex.dimension}, got ${vector.length}`,
        { field: fieldPath, expected: vecIndex.dimension, received: vector.length },
      )
    }
  }
}

export function prepareDocumentVectors(
  document: Record<string, unknown>,
  vectorFieldPaths: Set<string>,
  vecIndexes: Map<string, VectorIndex>,
): { partitionDoc: Record<string, unknown>; extractedVectors: Map<string, Float32Array> } {
  if (vecIndexes.size === 0) {
    return { partitionDoc: document, extractedVectors: new Map() }
  }

  const extractedVectors = new Map<string, Float32Array>()
  for (const fieldPath of vectorFieldPaths) {
    const vec = extractVectorFromDoc(document, fieldPath)
    if (vec) {
      extractedVectors.set(fieldPath, vec)
    }
  }

  if (extractedVectors.size === 0) {
    return { partitionDoc: document, extractedVectors }
  }

  const partitionDoc = shallowCopyExcluding(document, extractedVectors.keys())
  return { partitionDoc, extractedVectors }
}

function shallowCopyExcluding(
  document: Record<string, unknown>,
  fieldPaths: IterableIterator<string>,
): Record<string, unknown> {
  const topLevelExcludes = new Set<string>()
  const nestedPaths: string[] = []

  for (const path of fieldPaths) {
    if (!path.includes('.')) {
      topLevelExcludes.add(path)
    } else {
      nestedPaths.push(path)
    }
  }

  const result: Record<string, unknown> = {}
  for (const key of Object.keys(document)) {
    if (topLevelExcludes.has(key)) continue
    result[key] = document[key]
  }

  for (const path of nestedPaths) {
    const segments = path.split('.')
    const topKey = segments[0]
    if (!(topKey in result) || result[topKey] === null || typeof result[topKey] !== 'object') continue

    const source = document[topKey] as Record<string, unknown>
    let target: Record<string, unknown> = { ...source }
    result[topKey] = target

    for (let i = 1; i < segments.length - 1; i++) {
      const seg = segments[i]
      const next = target[seg]
      if (next === null || next === undefined || typeof next !== 'object') break
      const copy = { ...(next as Record<string, unknown>) }
      target[seg] = copy
      target = copy
    }

    delete target[segments[segments.length - 1]]
  }

  return result
}

export function insertDocumentVectors(
  docId: string,
  vectors: Map<string, Float32Array>,
  vecIndexes: Map<string, VectorIndex>,
): string[] {
  const insertedFields: string[] = []
  try {
    for (const [fieldPath, vector] of vectors) {
      const vecIndex = vecIndexes.get(fieldPath)
      if (!vecIndex) continue
      vecIndex.insert(docId, vector)
      insertedFields.push(fieldPath)
    }
  } catch (err) {
    for (const fieldPath of insertedFields) {
      const vecIndex = vecIndexes.get(fieldPath)
      if (vecIndex) {
        vecIndex.remove(docId)
      }
    }
    throw err
  }
  return insertedFields
}

export function removeDocumentVectors(docId: string, vecIndexes: Map<string, VectorIndex>): void {
  for (const [, vecIndex] of vecIndexes) {
    vecIndex.remove(docId)
  }
}

export function updateDocumentVectors(
  docId: string,
  vectors: Map<string, Float32Array | null>,
  vecIndexes: Map<string, VectorIndex>,
): void {
  const updatedFields: Array<{ fieldPath: string; oldVec: Float32Array | null }> = []

  try {
    for (const [fieldPath, newVec] of vectors) {
      const vecIndex = vecIndexes.get(fieldPath)
      if (!vecIndex) continue

      if (newVec === null) {
        if (vecIndex.has(docId)) {
          const oldVec = vecIndex.getVector(docId)
          vecIndex.remove(docId)
          updatedFields.push({ fieldPath, oldVec })
        }
        continue
      }

      const oldVec = vecIndex.getVector(docId)
      if (vectorsEqual(oldVec, newVec)) continue

      vecIndex.remove(docId)
      try {
        vecIndex.insert(docId, newVec)
        updatedFields.push({ fieldPath, oldVec })
      } catch (err) {
        if (oldVec) {
          vecIndex.insert(docId, oldVec)
        }
        throw err
      }
    }
  } catch (err) {
    for (const { fieldPath, oldVec } of updatedFields) {
      const vecIndex = vecIndexes.get(fieldPath)
      if (!vecIndex) continue
      vecIndex.remove(docId)
      if (oldVec) {
        vecIndex.insert(docId, oldVec)
      }
    }
    throw err
  }
}
