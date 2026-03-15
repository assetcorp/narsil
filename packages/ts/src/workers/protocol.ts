import { generateId } from '../core/id-generator'
import type { SerializablePartition } from '../types/internal'
import type { AnyDocument, IndexConfig } from '../types/schema'
import type { QueryParams } from '../types/search'

export type WorkerAction =
  | { type: 'insert'; indexName: string; docId: string; document: AnyDocument; requestId: string }
  | { type: 'remove'; indexName: string; docId: string; requestId: string }
  | { type: 'update'; indexName: string; docId: string; document: AnyDocument; requestId: string }
  | { type: 'query'; indexName: string; params: QueryParams; requestId: string }
  | { type: 'preflight'; indexName: string; params: QueryParams; requestId: string }
  | { type: 'get'; indexName: string; docId: string; requestId: string }
  | { type: 'has'; indexName: string; docId: string; requestId: string }
  | { type: 'count'; indexName: string; requestId: string }
  | { type: 'createIndex'; indexName: string; config: IndexConfig; requestId: string }
  | { type: 'dropIndex'; indexName: string; requestId: string }
  | { type: 'getStats'; indexName: string; requestId: string }
  | { type: 'clear'; indexName: string; requestId: string }
  | { type: 'serialize'; indexName: string; partitionId: number; requestId: string }
  | {
      type: 'deserialize'
      indexName: string
      partitionId: number
      data: SerializablePartition
      requestId: string
    }
  | { type: 'memoryReport'; requestId: string }
  | { type: 'shutdown'; requestId: string }

export type WorkerResponse =
  | { type: 'success'; requestId: string; data: unknown }
  | { type: 'error'; requestId: string; code: string; message: string }

const KNOWN_ACTION_TYPES: ReadonlyArray<WorkerAction['type']> = [
  'insert',
  'remove',
  'update',
  'query',
  'preflight',
  'get',
  'has',
  'count',
  'createIndex',
  'dropIndex',
  'getStats',
  'clear',
  'serialize',
  'deserialize',
  'memoryReport',
  'shutdown',
]

export function createRequestId(): string {
  return generateId()
}

export function isValidWorkerAction(msg: unknown): msg is WorkerAction {
  if (msg === null || msg === undefined || typeof msg !== 'object') {
    return false
  }

  const candidate = msg as Record<string, unknown>

  if (typeof candidate.type !== 'string' || typeof candidate.requestId !== 'string') {
    return false
  }

  return (KNOWN_ACTION_TYPES as ReadonlyArray<string>).includes(candidate.type)
}

export function isValidWorkerResponse(msg: unknown): msg is WorkerResponse {
  if (msg === null || msg === undefined || typeof msg !== 'object') {
    return false
  }

  const candidate = msg as Record<string, unknown>

  if (typeof candidate.requestId !== 'string') {
    return false
  }

  if (candidate.type !== 'success' && candidate.type !== 'error') {
    return false
  }

  return true
}
