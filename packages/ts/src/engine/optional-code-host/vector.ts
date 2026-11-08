import { createDocIdMap } from '#platform/doc-id-tables'
import { spawnNodeWorker } from '#platform/node-worker'
import { adoptSharedTurns } from '#platform/turn-budget'
import { bindSearchSignal, signalOfSearch } from '../../core/search-stop'
import { isNarsilError } from '../../errors'
import { detectRuntime } from '../../runtime/detect'
import {
  osqCodeBytes,
  osqRecordBytes,
  osqStagedQueryBytes,
  readTrailer,
  stageQueryLevels,
  unpackLevels,
  writeRecord,
} from '../../vector/osq/record'
import { VECTOR_FILE_MAX_VECTORS } from '../../vector/vector-index/checkpoint-payload'
import { deadBitsWhere, isDead } from '../../vector/vector-index/dead-bits'
import { bytesToVectors, vectorsToBytes } from '../../vector/vector-index/payload'
import { resolveWorkerEntry } from '../../workers/entry-point'
import { noteThreadSlotGone, noteThreadSlotLive, threadSlotGone } from '../../workers/thread-slot'
import { resolveWorkerCount } from '../../workers/worker-count'
import { requirePinnedState } from '../query/state'

export function vectorHostPart() {
  return {
    VECTOR_FILE_MAX_VECTORS,
    adoptSharedTurns,
    bindSearchSignal,
    bytesToVectors,
    createDocIdMap,
    deadBitsWhere,
    detectRuntime,
    isDead,
    isNarsilError,
    noteThreadSlotGone,
    noteThreadSlotLive,
    osqCodeBytes,
    osqRecordBytes,
    osqStagedQueryBytes,
    readTrailer,
    requirePinnedState,
    resolveWorkerCount,
    resolveWorkerEntry,
    signalOfSearch,
    spawnNodeWorker,
    stageQueryLevels,
    threadSlotGone,
    unpackLevels,
    vectorsToBytes,
    writeRecord,
  }
}
