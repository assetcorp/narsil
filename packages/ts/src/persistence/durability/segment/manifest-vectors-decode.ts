import { ErrorCodes, NarsilError } from '../../../errors'
import { VECTOR_FILE_MAX_VECTORS } from '../../../vector/vector-index/checkpoint-payload'
import { deadBytesFor } from '../../../vector/vector-index/dead-bits'
import { MAX_SEGMENT_ID, type VectorFieldRef, type VectorFileRef } from './manifest'

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `Segment manifest ${message}`, details)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_SEGMENT_ID
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

function normalizeFile(raw: unknown, fieldPath: string, nextFileId: number, seenIds: Set<number>): VectorFileRef {
  if (!isRecord(raw) || !isId(raw.id) || !isKey(raw.key)) invalid('has an invalid vector file reference', { fieldPath })
  if (raw.id >= nextFileId || seenIds.has(raw.id)) {
    invalid(`lists vector file ${raw.id} of "${fieldPath}" twice or at its next file id`, { fieldPath, id: raw.id })
  }
  seenIds.add(raw.id)
  const count = raw.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > VECTOR_FILE_MAX_VECTORS) {
    invalid(`gives vector file ${raw.id} of "${fieldPath}" an invalid count`, { fieldPath, id: raw.id, count })
  }
  const dead = raw.dead ?? null
  if (dead !== null && !(dead instanceof Uint8Array)) invalid('has dead vectors that are not bytes', { fieldPath })
  if (dead !== null && dead.byteLength !== deadBytesFor(count)) {
    invalid(`marks the dead vectors of file ${raw.id} of "${fieldPath}" with the wrong number of bytes`, {
      fieldPath,
      id: raw.id,
      count,
      bytes: dead.byteLength,
    })
  }
  return { id: raw.id, key: raw.key, count, dead }
}

function normalizeField(raw: unknown, seenFields: Set<string>): VectorFieldRef {
  if (!isRecord(raw) || typeof raw.fieldPath !== 'string') invalid('has an invalid vector reference', { vector: raw })
  const fieldPath = raw.fieldPath
  if (seenFields.has(fieldPath)) invalid(`lists the vector field "${fieldPath}" twice`, { fieldPath })
  seenFields.add(fieldPath)
  if (!isId(raw.nextFileId)) invalid(`gives "${fieldPath}" an invalid next file id`, { fieldPath })
  if (!Array.isArray(raw.files)) invalid(`gives "${fieldPath}" no list of vector files`, { fieldPath })
  if (!isId(raw.graphGeneration)) invalid(`gives "${fieldPath}" an invalid graph generation`, { fieldPath })
  const graphKey = raw.graphKey ?? null
  if (graphKey !== null && !isKey(graphKey)) invalid(`gives "${fieldPath}" an invalid graph key`, { fieldPath })
  if (graphKey !== null && raw.graphGeneration === 0) {
    invalid(`names a graph file for "${fieldPath}" at generation 0`, { fieldPath })
  }
  const nextFileId = raw.nextFileId
  const seenIds = new Set<number>()
  return {
    fieldPath,
    nextFileId,
    files: raw.files.map(file => normalizeFile(file, fieldPath, nextFileId, seenIds)),
    graphGeneration: raw.graphGeneration,
    graphKey,
  }
}

export function normalizeVectorFields(raw: unknown): VectorFieldRef[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) invalid('has malformed vector references')
  const seenFields = new Set<string>()
  return raw.map(field => normalizeField(field, seenFields))
}
