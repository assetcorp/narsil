import { decode } from '@msgpack/msgpack'
import { getNestedValue } from '../../core/partition/utils'
import { insertDocumentVectors, prepareDocumentVectors, removeDocumentVectors } from '../../engine/vector-coordinator'
import type { PartitionManager } from '../../partitioning/manager'
import type { VectorIndex } from '../../vector/vector-index'
import type { EntryValidation, ReplicationLog, ReplicationLogEntry } from './types'

export function validateReplicationEntry(
  entry: ReplicationLogEntry,
  localPrimaryTerm: number,
  log: ReplicationLog,
): EntryValidation {
  if (!log.verifyChecksum(entry)) {
    return { valid: false, error: 'REPLICATION_ENTRY_CORRUPT' }
  }

  if (entry.primaryTerm < localPrimaryTerm) {
    return { valid: false, error: 'REPLICATION_TERM_MISMATCH' }
  }

  return { valid: true }
}

export function applyIndexEntry(
  entry: ReplicationLogEntry,
  manager: PartitionManager,
  vectorFieldPaths: Set<string>,
  vecIndexes: Map<string, VectorIndex>,
): void {
  if (entry.document === null) {
    return
  }

  const document = decode(entry.document) as Record<string, unknown>
  restoreVectorFields(document, vectorFieldPaths)

  if (manager.has(entry.documentId)) {
    removeDocumentVectors(entry.documentId, vecIndexes)
    manager.remove(entry.documentId)
  }

  const { partitionDoc, extractedVectors } = prepareDocumentVectors(document, vectorFieldPaths, vecIndexes)
  manager.insert(entry.documentId, partitionDoc)
  try {
    insertDocumentVectors(entry.documentId, extractedVectors, vecIndexes)
  } catch (err) {
    manager.remove(entry.documentId)
    throw err
  }

  for (const fieldPath of extractedVectors.keys()) {
    const vecIndex = vecIndexes.get(fieldPath)
    if (vecIndex) {
      vecIndex.scheduleBuild()
    }
  }
}

export function applyDeleteEntry(
  entry: ReplicationLogEntry,
  manager: PartitionManager,
  vecIndexes: Map<string, VectorIndex>,
): void {
  if (!manager.has(entry.documentId)) {
    return
  }

  removeDocumentVectors(entry.documentId, vecIndexes)
  manager.remove(entry.documentId)
}

function restoreVectorFields(document: Record<string, unknown>, vectorFieldPaths: Set<string>): void {
  for (const fieldPath of vectorFieldPaths) {
    const value = getNestedValue(document, fieldPath)
    if (value instanceof Uint8Array && !(value instanceof Float32Array)) {
      if (value.byteLength % 4 !== 0) {
        throw new Error(
          `Vector field "${fieldPath}" has invalid byte length ${value.byteLength} (must be divisible by 4)`,
        )
      }
      const elementCount = value.byteLength / 4
      const float32 = new Float32Array(elementCount)
      const dataView = new DataView(value.buffer, value.byteOffset, value.byteLength)
      for (let i = 0; i < elementCount; i++) {
        float32[i] = dataView.getFloat32(i * 4, true)
      }
      setNestedValue(document, fieldPath, float32)
    }
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

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
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]
    if (FORBIDDEN_KEYS.has(segment)) {
      return
    }
    let next = current[segment]
    if (next === null || next === undefined || typeof next !== 'object') {
      next = {}
      current[segment] = next
    }
    current = next as Record<string, unknown>
  }
  const finalSegment = segments[segments.length - 1]
  if (FORBIDDEN_KEYS.has(finalSegment)) {
    return
  }
  current[finalSegment] = value
}
