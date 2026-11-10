import type { OptionalCodeHost } from '../../engine/optional-code-host'

type EngineNames = Pick<
  OptionalCodeHost,
  | 'DEFAULT_LINEAR_ALPHA'
  | 'DEFAULT_RANK_CONSTANT'
  | 'DISK_STORAGE_BLOCK_BYTES'
  | 'ErrorCodes'
  | 'FUSION_TIE_INSERTION_LIMIT'
  | 'GRAPH_BUILD_CHUNKS_IN_FLIGHT_PER_WORKER'
  | 'GRAPH_BUILD_DISPATCH_CHUNK'
  | 'MAX_LINEAR_ALPHA'
  | 'MAX_RENUMBERED_SEARCH_ATTEMPTS'
  | 'MIN_LINEAR_ALPHA'
  | 'MIN_RANK_CONSTANT'
  | 'NATIVE_THREAD_SCAN_CHUNK_ORDINALS'
  | 'NarsilError'
  | 'RESULT_WINDOW'
  | 'UNPLACED_FLAG_CHUNK_ORDINALS'
  | 'VECTOR_INSERT_TIMEOUT_MS'
  | 'VECTOR_SCRATCH_SLOTS'
  | 'VECTOR_SEARCH_LOAD_TIMEOUT_MS'
  | 'VECTOR_SEARCH_TIMEOUT_MS'
  | 'WORKER_YOUNG_GENERATION_MB'
  | 'bindSearchSignal'
  | 'compareCodePoints'
  | 'createDocIdMap'
  | 'detectRuntime'
  | 'isNarsilError'
  | 'noteThreadSlotGone'
  | 'noteThreadSlotLive'
  | 'requirePinnedState'
  | 'resolveWorkerCount'
  | 'resolveWorkerEntry'
  | 'signalOfSearch'
  | 'spawnNodeWorker'
  | 'turnIsSpent'
  | 'yieldTurn'
>

export let DEFAULT_LINEAR_ALPHA: EngineNames['DEFAULT_LINEAR_ALPHA']
export let DEFAULT_RANK_CONSTANT: EngineNames['DEFAULT_RANK_CONSTANT']
export let DISK_STORAGE_BLOCK_BYTES: EngineNames['DISK_STORAGE_BLOCK_BYTES']
export let ErrorCodes: EngineNames['ErrorCodes']
export let FUSION_TIE_INSERTION_LIMIT: EngineNames['FUSION_TIE_INSERTION_LIMIT']
export let GRAPH_BUILD_CHUNKS_IN_FLIGHT_PER_WORKER: EngineNames['GRAPH_BUILD_CHUNKS_IN_FLIGHT_PER_WORKER']
export let GRAPH_BUILD_DISPATCH_CHUNK: EngineNames['GRAPH_BUILD_DISPATCH_CHUNK']
export let MAX_LINEAR_ALPHA: EngineNames['MAX_LINEAR_ALPHA']
export let MAX_RENUMBERED_SEARCH_ATTEMPTS: EngineNames['MAX_RENUMBERED_SEARCH_ATTEMPTS']
export let MIN_LINEAR_ALPHA: EngineNames['MIN_LINEAR_ALPHA']
export let MIN_RANK_CONSTANT: EngineNames['MIN_RANK_CONSTANT']
export let NATIVE_THREAD_SCAN_CHUNK_ORDINALS: EngineNames['NATIVE_THREAD_SCAN_CHUNK_ORDINALS']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>
export let RESULT_WINDOW: EngineNames['RESULT_WINDOW']
export let UNPLACED_FLAG_CHUNK_ORDINALS: EngineNames['UNPLACED_FLAG_CHUNK_ORDINALS']
export let VECTOR_INSERT_TIMEOUT_MS: EngineNames['VECTOR_INSERT_TIMEOUT_MS']
export let VECTOR_SCRATCH_SLOTS: EngineNames['VECTOR_SCRATCH_SLOTS']
export let VECTOR_SEARCH_LOAD_TIMEOUT_MS: EngineNames['VECTOR_SEARCH_LOAD_TIMEOUT_MS']
export let VECTOR_SEARCH_TIMEOUT_MS: EngineNames['VECTOR_SEARCH_TIMEOUT_MS']
export let WORKER_YOUNG_GENERATION_MB: EngineNames['WORKER_YOUNG_GENERATION_MB']
export let bindSearchSignal: EngineNames['bindSearchSignal']
export let compareCodePoints: EngineNames['compareCodePoints']
export let createDocIdMap: EngineNames['createDocIdMap']
export let detectRuntime: EngineNames['detectRuntime']
export let isNarsilError: EngineNames['isNarsilError']
export let noteThreadSlotGone: EngineNames['noteThreadSlotGone']
export let noteThreadSlotLive: EngineNames['noteThreadSlotLive']
export let requirePinnedState: EngineNames['requirePinnedState']
export let resolveWorkerCount: EngineNames['resolveWorkerCount']
export let resolveWorkerEntry: EngineNames['resolveWorkerEntry']
export let signalOfSearch: EngineNames['signalOfSearch']
export let spawnNodeWorker: EngineNames['spawnNodeWorker']
export let turnIsSpent: EngineNames['turnIsSpent']
export let yieldTurn: EngineNames['yieldTurn']

export function bindEngineNames(host: EngineNames): void {
  ;({
    DEFAULT_LINEAR_ALPHA,
    DEFAULT_RANK_CONSTANT,
    DISK_STORAGE_BLOCK_BYTES,
    ErrorCodes,
    FUSION_TIE_INSERTION_LIMIT,
    GRAPH_BUILD_CHUNKS_IN_FLIGHT_PER_WORKER,
    GRAPH_BUILD_DISPATCH_CHUNK,
    MAX_LINEAR_ALPHA,
    MAX_RENUMBERED_SEARCH_ATTEMPTS,
    MIN_LINEAR_ALPHA,
    MIN_RANK_CONSTANT,
    NATIVE_THREAD_SCAN_CHUNK_ORDINALS,
    NarsilError,
    RESULT_WINDOW,
    UNPLACED_FLAG_CHUNK_ORDINALS,
    VECTOR_INSERT_TIMEOUT_MS,
    VECTOR_SCRATCH_SLOTS,
    VECTOR_SEARCH_LOAD_TIMEOUT_MS,
    VECTOR_SEARCH_TIMEOUT_MS,
    WORKER_YOUNG_GENERATION_MB,
    bindSearchSignal,
    compareCodePoints,
    createDocIdMap,
    detectRuntime,
    isNarsilError,
    noteThreadSlotGone,
    noteThreadSlotLive,
    requirePinnedState,
    resolveWorkerCount,
    resolveWorkerEntry,
    signalOfSearch,
    spawnNodeWorker,
    turnIsSpent,
    yieldTurn,
  } = host)
}
