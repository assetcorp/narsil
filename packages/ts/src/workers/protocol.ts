import type { PartitionInsertOptions } from '../core/partition'
import type { PagedSegmentSnapshot, SharedSegmentSnapshot } from '../core/partition/frozen'
import type { RemovedSpellings } from '../core/partition/frozen/surface-slot'
import type { SegmentPayload } from '../core/partition/segment-payload'
import type { SharedPatternWork } from '../core/pattern-index/work-meter'
import type { LongQueryThreadSettings, RequestThreadSettings } from '../server/request-threads/messages'
import type { GlobalStatistics, SerializablePartition, SerializedSurfaceForms } from '../types/internal'
import type { AnyDocument, BM25Params, IndexConfig } from '../types/schema'
import type { QueryParams } from '../types/search'
import type { SharedVectorFieldHandles } from '../vector/shared-field/types'

export type WorkerAction =
  | { type: 'insert'; indexName: string; docId: string; document: AnyDocument; requestId: string; skipClone?: boolean }
  | { type: 'remove'; indexName: string; docId: string; requestId: string; removedSpellings?: RemovedSpellings }
  | {
      type: 'update'
      indexName: string
      docId: string
      document: AnyDocument
      requestId: string
      removedSpellings?: RemovedSpellings
    }
  | {
      type: 'query'
      indexName: string
      params: QueryParams
      requestId: string
      partitionIds?: number[]
      globalStats?: GlobalStatistics
      patternWork: SharedPatternWork
      bm25: BM25Params | null
    }
  | { type: 'preflight'; indexName: string; params: QueryParams; requestId: string; patternWork: SharedPatternWork }
  | { type: 'get'; indexName: string; docId: string; requestId: string }
  | { type: 'has'; indexName: string; docId: string; requestId: string }
  | { type: 'count'; indexName: string; requestId: string }
  | {
      type: 'createIndex'
      indexName: string
      config: IndexConfig
      requestId: string
      analysisStale?: boolean
      copyLoad?: string
      synonyms?: Uint8Array
    }
  | { type: 'replaceSynonyms'; indexName: string; synonyms?: Uint8Array; requestId: string }
  | { type: 'replaceBm25'; indexName: string; bm25?: BM25Params; requestId: string }
  | { type: 'copyLoaded'; indexName: string; copyLoad: string; requestId: string }
  | {
      type: 'loadVectorCopy'
      indexName: string
      fieldName: string
      handle: string
      handles: SharedVectorFieldHandles
      requestId: string
    }
  | { type: 'dropVectorCopy'; indexName: string; fieldName: string; handle: string; requestId: string }
  | {
      type: 'insertVectorOrdinals'
      indexName: string
      fieldName: string
      handle: string
      ordinals: Int32Array
      requestId: string
    }
  | { type: 'serveRequests'; settings: RequestThreadSettings; requestId: string }
  | { type: 'serveLongQueries'; settings: LongQueryThreadSettings; requestId: string }
  | { type: 'stopServing'; requestId: string }
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
  | {
      type: 'buildSegment'
      indexName: string
      segmentId: string
      documents: Array<{ docId: string; document: AnyDocument }>
      options?: PartitionInsertOptions
      requestId: string
    }
  | {
      type: 'mergeSegments'
      indexName: string
      segments: Array<{ partitionId: number; payload: SegmentPayload; documents: AnyDocument[] }>
      requestId: string
      skipClone?: boolean
    }
  | {
      type: 'attachSegments'
      indexName: string
      segments: Array<{
        partitionId: number
        snapshot: SharedSegmentSnapshot | PagedSegmentSnapshot
        tombstonedDocIds?: string[]
        survivingSurfaceForms?: SerializedSurfaceForms
      }>
      requestId: string
    }
  | {
      type: 'compactSegments'
      indexName: string
      partitionId: number
      segmentIds: string[]
      requestId: string
    }
  | {
      type: 'swapSegments'
      indexName: string
      partitionId: number
      dropSegmentIds: string[]
      snapshot: SharedSegmentSnapshot
      removedSpellings?: ReadonlyMap<string, RemovedSpellings>
      requestId: string
    }
  | {
      type: 'freezeLiveTail'
      indexName: string
      partitionId: number
      snapshot: SharedSegmentSnapshot
      requestId: string
    }
  | {
      type: 'adoptDiskSegments'
      indexName: string
      partitions: DiskAdoptionPartition[]
      changed: string[]
      requestId: string
    }
  | { type: 'memoryReport'; requestId: string }
  | { type: 'bootstrap'; moduleUrl: string; requestId: string }
  | { type: 'shutdown'; requestId: string }

export type DiskAdoptionSegment = { snapshot: PagedSegmentSnapshot } | { segmentId: string }

export interface DiskAdoptionPartition {
  partitionId: number
  segments: DiskAdoptionSegment[]
}

export type BuiltSegmentResult =
  | { kind: 'shared'; snapshot: SharedSegmentSnapshot }
  | { kind: 'payload'; payload: SegmentPayload }

export type WorkerResponse =
  | { type: 'success'; requestId: string; data: unknown }
  | { type: 'error'; requestId: string; code: string; message: string; details?: Record<string, unknown> }

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
  'replaceSynonyms',
  'replaceBm25',
  'copyLoaded',
  'loadVectorCopy',
  'dropVectorCopy',
  'insertVectorOrdinals',
  'serveRequests',
  'serveLongQueries',
  'stopServing',
  'dropIndex',
  'getStats',
  'clear',
  'serialize',
  'deserialize',
  'buildSegment',
  'mergeSegments',
  'attachSegments',
  'compactSegments',
  'swapSegments',
  'freezeLiveTail',
  'adoptDiskSegments',
  'memoryReport',
  'bootstrap',
  'shutdown',
]

export type DiskAdoptionAction = Extract<WorkerAction, { type: 'adoptDiskSegments' }>

let nextRequestSequence = 0

export function createRequestId(): string {
  nextRequestSequence += 1
  return String(nextRequestSequence)
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
