import type { OptionalCodeHost } from '../engine/optional-code-host'

export { compareCodePoints } from '../core/ordering'
export { ErrorCodes, NarsilError } from '../errors'
export { threadSlotGone } from '../workers/thread-slot'
export {
  osqCodeBytes,
  osqRecordBytes,
  osqStagedQueryBytes,
  readTrailer,
  stageQueryLevels,
  unpackLevels,
  writeRecord,
} from './osq/record'
export { VECTOR_FILE_MAX_VECTORS } from './vector-index/checkpoint-payload'
export { deadBitsWhere } from './vector-index/dead-bits'
export { bytesToVectors, vectorsToBytes } from './vector-index/payload'

export function bindVectorCoreHost(_host: OptionalCodeHost): void {}
