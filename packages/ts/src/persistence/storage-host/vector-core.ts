import type * as VectorCoreCode from '../../vector/core-leaf'

type VectorCoreNames = Pick<
  typeof VectorCoreCode,
  | 'DEFAULT_VECTOR_METRIC'
  | 'VECTOR_FILE_MAX_VECTORS'
  | 'VECTOR_FILE_PAYLOAD_VERSION'
  | 'assembleGraphParts'
  | 'bytesToVectors'
  | 'collectAndReturnPages'
  | 'computeCodeBlockLayout'
  | 'countDead'
  | 'createFixedBuffer'
  | 'createHNSWIndex'
  | 'createOsqScratch'
  | 'createVectorFileReader'
  | 'deadBytesFor'
  | 'decodeVectorFilePayload'
  | 'decodeVectorGraphPartPayload'
  | 'decodeVectorGraphPayload'
  | 'decodeVectorIndexParts'
  | 'defaultEfSearch'
  | 'defaultQuantizationFor'
  | 'defaultRescoreDepth'
  | 'graphPartsOfEarlierPayload'
  | 'isDead'
  | 'loadNativeCore'
  | 'magnitude'
  | 'nativeSearchCoreIsEnabled'
  | 'osqBitsOf'
  | 'osqDistance'
  | 'osqEstimate'
  | 'osqQuantize'
  | 'osqRecordBytes'
  | 'readTrailer'
  | 'scalarQueryProducts'
  | 'stageQueryLevels'
  | 'toDistance'
  | 'toScore'
  | 'vectorsPerFile'
  | 'vectorsToBytes'
>

export let DEFAULT_VECTOR_METRIC: VectorCoreNames['DEFAULT_VECTOR_METRIC']
export let VECTOR_FILE_MAX_VECTORS: VectorCoreNames['VECTOR_FILE_MAX_VECTORS']
export let VECTOR_FILE_PAYLOAD_VERSION: VectorCoreNames['VECTOR_FILE_PAYLOAD_VERSION']
export let assembleGraphParts: VectorCoreNames['assembleGraphParts']
export let bytesToVectors: VectorCoreNames['bytesToVectors']
export let collectAndReturnPages: VectorCoreNames['collectAndReturnPages']
export let computeCodeBlockLayout: VectorCoreNames['computeCodeBlockLayout']
export let countDead: VectorCoreNames['countDead']
export let createFixedBuffer: VectorCoreNames['createFixedBuffer']
export let createHNSWIndex: VectorCoreNames['createHNSWIndex']
export let createOsqScratch: VectorCoreNames['createOsqScratch']
export let createVectorFileReader: VectorCoreNames['createVectorFileReader']
export let deadBytesFor: VectorCoreNames['deadBytesFor']
export let decodeVectorFilePayload: VectorCoreNames['decodeVectorFilePayload']
export let decodeVectorGraphPartPayload: VectorCoreNames['decodeVectorGraphPartPayload']
export let decodeVectorGraphPayload: VectorCoreNames['decodeVectorGraphPayload']
export let decodeVectorIndexParts: VectorCoreNames['decodeVectorIndexParts']
export let defaultEfSearch: VectorCoreNames['defaultEfSearch']
export let defaultQuantizationFor: VectorCoreNames['defaultQuantizationFor']
export let defaultRescoreDepth: VectorCoreNames['defaultRescoreDepth']
export let graphPartsOfEarlierPayload: VectorCoreNames['graphPartsOfEarlierPayload']
export let isDead: VectorCoreNames['isDead']
export let loadNativeCore: VectorCoreNames['loadNativeCore']
export let magnitude: VectorCoreNames['magnitude']
export let nativeSearchCoreIsEnabled: VectorCoreNames['nativeSearchCoreIsEnabled']
export let osqBitsOf: VectorCoreNames['osqBitsOf']
export let osqDistance: VectorCoreNames['osqDistance']
export let osqEstimate: VectorCoreNames['osqEstimate']
export let osqQuantize: VectorCoreNames['osqQuantize']
export let osqRecordBytes: VectorCoreNames['osqRecordBytes']
export let readTrailer: VectorCoreNames['readTrailer']
export let scalarQueryProducts: VectorCoreNames['scalarQueryProducts']
export let stageQueryLevels: VectorCoreNames['stageQueryLevels']
export let toDistance: VectorCoreNames['toDistance']
export let toScore: VectorCoreNames['toScore']
export let vectorsPerFile: VectorCoreNames['vectorsPerFile']
export let vectorsToBytes: VectorCoreNames['vectorsToBytes']

export function bindVectorCoreNames(vectorCore: VectorCoreNames): void {
  ;({
    DEFAULT_VECTOR_METRIC,
    VECTOR_FILE_MAX_VECTORS,
    VECTOR_FILE_PAYLOAD_VERSION,
    assembleGraphParts,
    bytesToVectors,
    collectAndReturnPages,
    computeCodeBlockLayout,
    countDead,
    createFixedBuffer,
    createHNSWIndex,
    createOsqScratch,
    createVectorFileReader,
    deadBytesFor,
    decodeVectorFilePayload,
    decodeVectorGraphPartPayload,
    decodeVectorGraphPayload,
    decodeVectorIndexParts,
    defaultEfSearch,
    defaultQuantizationFor,
    defaultRescoreDepth,
    graphPartsOfEarlierPayload,
    isDead,
    loadNativeCore,
    magnitude,
    nativeSearchCoreIsEnabled,
    osqBitsOf,
    osqDistance,
    osqEstimate,
    osqQuantize,
    osqRecordBytes,
    readTrailer,
    scalarQueryProducts,
    stageQueryLevels,
    toDistance,
    toScore,
    vectorsPerFile,
    vectorsToBytes,
  } = vectorCore)
}
