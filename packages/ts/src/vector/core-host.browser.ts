import type { OptionalCodeHost } from '../engine/optional-code-host'

type EngineNames = Pick<
  OptionalCodeHost,
  | 'ErrorCodes'
  | 'NarsilError'
  | 'VECTOR_FILE_MAX_VECTORS'
  | 'adoptSharedTurns'
  | 'bytesToVectors'
  | 'compareCodePoints'
  | 'deadBitsWhere'
  | 'osqCodeBytes'
  | 'osqRecordBytes'
  | 'osqStagedQueryBytes'
  | 'readTrailer'
  | 'stageQueryLevels'
  | 'threadSlotGone'
  | 'unpackLevels'
  | 'vectorsToBytes'
  | 'writeRecord'
>

export let ErrorCodes: EngineNames['ErrorCodes']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>
export let VECTOR_FILE_MAX_VECTORS: EngineNames['VECTOR_FILE_MAX_VECTORS']
export let adoptSharedTurns: EngineNames['adoptSharedTurns']
export let bytesToVectors: EngineNames['bytesToVectors']
export let compareCodePoints: EngineNames['compareCodePoints']
export let deadBitsWhere: EngineNames['deadBitsWhere']
export let osqCodeBytes: EngineNames['osqCodeBytes']
export let osqRecordBytes: EngineNames['osqRecordBytes']
export let osqStagedQueryBytes: EngineNames['osqStagedQueryBytes']
export let readTrailer: EngineNames['readTrailer']
export let stageQueryLevels: EngineNames['stageQueryLevels']
export let threadSlotGone: EngineNames['threadSlotGone']
export let unpackLevels: EngineNames['unpackLevels']
export let vectorsToBytes: EngineNames['vectorsToBytes']
export let writeRecord: EngineNames['writeRecord']

export function bindVectorCoreHost(host: EngineNames): void {
  ;({
    ErrorCodes,
    NarsilError,
    VECTOR_FILE_MAX_VECTORS,
    adoptSharedTurns,
    bytesToVectors,
    compareCodePoints,
    deadBitsWhere,
    osqCodeBytes,
    osqRecordBytes,
    osqStagedQueryBytes,
    readTrailer,
    stageQueryLevels,
    threadSlotGone,
    unpackLevels,
    vectorsToBytes,
    writeRecord,
  } = host)
}
