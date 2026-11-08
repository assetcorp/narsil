import type { OptionalCodeHost } from '../engine/optional-code-host'

type EngineNames = Pick<
  OptionalCodeHost,
  | 'Decoder'
  | 'ErrorCodes'
  | 'MAP_TAGS'
  | 'NarsilError'
  | 'PROTOTYPE_POLLUTION_KEYS'
  | 'assembleFrozenSegment'
  | 'cloneProjected'
  | 'createPartitionIndex'
  | 'decode'
  | 'decodeSurfaceTable'
  | 'documentWithOwnBuffers'
  | 'encodeDocument'
  | 'getNestedValue'
  | 'headerAt'
  | 'loadStorageCode'
  | 'projectIncludedPaths'
  | 'raiseEarlierReleaseGraphSetting'
  | 'readProjectedPath'
  | 'resolvePartialWordAnalysis'
  | 'resolvePartitionInsertOptions'
  | 'valueWithOwnBuffers'
  | 'wrapExternalIdTable'
  | 'wrapFrozenTokenTable'
  | 'writePartitionDocument'
  | 'yieldToEventLoop'
>

export let Decoder: EngineNames['Decoder']
export type Decoder = InstanceType<EngineNames['Decoder']>
export let ErrorCodes: EngineNames['ErrorCodes']
export let MAP_TAGS: EngineNames['MAP_TAGS']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>
export let PROTOTYPE_POLLUTION_KEYS: EngineNames['PROTOTYPE_POLLUTION_KEYS']
export let assembleFrozenSegment: EngineNames['assembleFrozenSegment']
export let cloneProjected: EngineNames['cloneProjected']
export let createPartitionIndex: EngineNames['createPartitionIndex']
export let decode: EngineNames['decode']
export let decodeSurfaceTable: EngineNames['decodeSurfaceTable']
export let documentWithOwnBuffers: EngineNames['documentWithOwnBuffers']
export let encodeDocument: EngineNames['encodeDocument']
export let getNestedValue: EngineNames['getNestedValue']
export let headerAt: EngineNames['headerAt']
export let loadStorageCode: EngineNames['loadStorageCode']
export let projectIncludedPaths: EngineNames['projectIncludedPaths']
export let raiseEarlierReleaseGraphSetting: EngineNames['raiseEarlierReleaseGraphSetting']
export let readProjectedPath: EngineNames['readProjectedPath']
export let resolvePartialWordAnalysis: EngineNames['resolvePartialWordAnalysis']
export let resolvePartitionInsertOptions: EngineNames['resolvePartitionInsertOptions']
export let valueWithOwnBuffers: EngineNames['valueWithOwnBuffers']
export let wrapExternalIdTable: EngineNames['wrapExternalIdTable']
export let wrapFrozenTokenTable: EngineNames['wrapFrozenTokenTable']
export let writePartitionDocument: EngineNames['writePartitionDocument']
export let yieldToEventLoop: EngineNames['yieldToEventLoop']

export function bindSegmentCodecHost(host: EngineNames): void {
  ;({
    Decoder,
    ErrorCodes,
    MAP_TAGS,
    NarsilError,
    PROTOTYPE_POLLUTION_KEYS,
    assembleFrozenSegment,
    cloneProjected,
    createPartitionIndex,
    decode,
    decodeSurfaceTable,
    documentWithOwnBuffers,
    encodeDocument,
    getNestedValue,
    headerAt,
    loadStorageCode,
    projectIncludedPaths,
    raiseEarlierReleaseGraphSetting,
    readProjectedPath,
    resolvePartialWordAnalysis,
    resolvePartitionInsertOptions,
    valueWithOwnBuffers,
    wrapExternalIdTable,
    wrapFrozenTokenTable,
    writePartitionDocument,
    yieldToEventLoop,
  } = host)
}
