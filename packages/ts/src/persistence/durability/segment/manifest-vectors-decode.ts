import { VECTOR_FILE_MAX_VECTORS } from '../../../vector/vector-index/checkpoint-payload'
import { deadBytesFor } from '../../../vector/vector-index/dead-bits'
import { graphPartKey, vectorFileKey } from './layout'
import type { FileRef, VectorFieldRef, VectorFileRef } from './manifest'
import { invalidManifest, isId, isRecord, readFileRef } from './manifest-fields'

function normalizeFile(
  raw: unknown,
  indexName: string,
  fieldPath: string,
  nextFileId: number,
  seenIds: Set<number>,
): VectorFileRef {
  if (!isRecord(raw) || !isId(raw.id)) invalidManifest('has an invalid vector file reference', { fieldPath })
  if (raw.id >= nextFileId || seenIds.has(raw.id)) {
    invalidManifest(`lists vector file ${raw.id} of "${fieldPath}" twice or at its next file id`, { fieldPath })
  }
  seenIds.add(raw.id)
  const count = raw.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > VECTOR_FILE_MAX_VECTORS) {
    invalidManifest(`gives vector file ${raw.id} of "${fieldPath}" an invalid count`, { fieldPath, count })
  }
  const dead = raw.dead ?? null
  if (dead !== null && !(dead instanceof Uint8Array)) invalidManifest('has dead vectors that are not bytes')
  if (dead !== null && dead.byteLength !== deadBytesFor(count)) {
    invalidManifest(`marks the dead vectors of file ${raw.id} of "${fieldPath}" with the wrong number of bytes`)
  }
  const ref = readFileRef(raw, vectorFileKey(indexName, fieldPath, raw.id), 'vector file')
  return { ...ref, id: raw.id, count, dead }
}

function normalizeGraphParts(raw: unknown, indexName: string, fieldPath: string, generation: number): FileRef[] {
  if (!Array.isArray(raw)) invalidManifest(`gives "${fieldPath}" no list of graph parts`, { fieldPath })
  if (raw.length > 0 && generation === 0) invalidManifest(`lists graph parts of "${fieldPath}" at generation 0`)
  return raw.map((part, at) => {
    if (!isRecord(part)) invalidManifest(`has an invalid graph part of "${fieldPath}"`, { fieldPath })
    return readFileRef(part, graphPartKey(indexName, fieldPath, generation, at), 'graph part')
  })
}

function normalizeField(raw: unknown, indexName: string, seenFields: Set<string>): VectorFieldRef {
  if (!isRecord(raw) || typeof raw.fieldPath !== 'string') invalidManifest('has an invalid vector reference')
  const fieldPath = raw.fieldPath
  if (seenFields.has(fieldPath)) invalidManifest(`lists the vector field "${fieldPath}" twice`, { fieldPath })
  seenFields.add(fieldPath)
  if (!isId(raw.nextFileId)) invalidManifest(`gives "${fieldPath}" an invalid next file id`, { fieldPath })
  if (!Array.isArray(raw.files)) invalidManifest(`gives "${fieldPath}" no list of vector files`, { fieldPath })
  if (!isId(raw.graphGeneration)) invalidManifest(`gives "${fieldPath}" an invalid graph generation`, { fieldPath })
  const nextFileId = raw.nextFileId
  const seenIds = new Set<number>()
  return {
    fieldPath,
    nextFileId,
    files: raw.files.map(file => normalizeFile(file, indexName, fieldPath, nextFileId, seenIds)),
    graphGeneration: raw.graphGeneration,
    graphParts: normalizeGraphParts(raw.graphParts, indexName, fieldPath, raw.graphGeneration),
  }
}

export function normalizeVectorFields(raw: unknown, indexName: string): VectorFieldRef[] {
  if (!Array.isArray(raw)) invalidManifest('has malformed vector references')
  const seenFields = new Set<string>()
  return raw.map(field => normalizeField(field, indexName, seenFields))
}
