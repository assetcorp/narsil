import type * as VectorCoreCode from '../../vector/core-leaf'

type VectorCoreNames = Pick<
  typeof VectorCoreCode,
  | 'DEFAULT_VECTOR_METRIC'
  | 'collectAndReturnPages'
  | 'computeCodeBlockLayout'
  | 'createFixedBuffer'
  | 'createHNSWIndex'
  | 'createOsqScratch'
  | 'createVectorFileReader'
  | 'defaultEfSearch'
  | 'defaultQuantizationFor'
  | 'defaultRescoreDepth'
  | 'loadNativeCore'
  | 'magnitude'
  | 'nativeSearchCoreIsEnabled'
  | 'osqBitsOf'
  | 'osqDistance'
  | 'osqEstimate'
  | 'osqQuantize'
  | 'scalarQueryProducts'
  | 'toDistance'
  | 'toScore'
  | 'vectorsPerFile'
>

export let DEFAULT_VECTOR_METRIC: VectorCoreNames['DEFAULT_VECTOR_METRIC']
export let collectAndReturnPages: VectorCoreNames['collectAndReturnPages']
export let computeCodeBlockLayout: VectorCoreNames['computeCodeBlockLayout']
export let createFixedBuffer: VectorCoreNames['createFixedBuffer']
export let createHNSWIndex: VectorCoreNames['createHNSWIndex']
export let createOsqScratch: VectorCoreNames['createOsqScratch']
export let createVectorFileReader: VectorCoreNames['createVectorFileReader']
export let defaultEfSearch: VectorCoreNames['defaultEfSearch']
export let defaultQuantizationFor: VectorCoreNames['defaultQuantizationFor']
export let defaultRescoreDepth: VectorCoreNames['defaultRescoreDepth']
export let loadNativeCore: VectorCoreNames['loadNativeCore']
export let magnitude: VectorCoreNames['magnitude']
export let nativeSearchCoreIsEnabled: VectorCoreNames['nativeSearchCoreIsEnabled']
export let osqBitsOf: VectorCoreNames['osqBitsOf']
export let osqDistance: VectorCoreNames['osqDistance']
export let osqEstimate: VectorCoreNames['osqEstimate']
export let osqQuantize: VectorCoreNames['osqQuantize']
export let scalarQueryProducts: VectorCoreNames['scalarQueryProducts']
export let toDistance: VectorCoreNames['toDistance']
export let toScore: VectorCoreNames['toScore']
export let vectorsPerFile: VectorCoreNames['vectorsPerFile']

export function bindVectorCoreNames(vectorCore: VectorCoreNames): void {
  ;({
    DEFAULT_VECTOR_METRIC,
    collectAndReturnPages,
    computeCodeBlockLayout,
    createFixedBuffer,
    createHNSWIndex,
    createOsqScratch,
    createVectorFileReader,
    defaultEfSearch,
    defaultQuantizationFor,
    defaultRescoreDepth,
    loadNativeCore,
    magnitude,
    nativeSearchCoreIsEnabled,
    osqBitsOf,
    osqDistance,
    osqEstimate,
    osqQuantize,
    scalarQueryProducts,
    toDistance,
    toScore,
    vectorsPerFile,
  } = vectorCore)
}
