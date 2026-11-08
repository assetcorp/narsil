import type { OptionalCodeHost } from '../engine/optional-code-host'
import type * as MsgpackCode from '../serialization/msgpack-leaf'

type EngineNames = Pick<
  OptionalCodeHost,
  | 'ErrorCodes'
  | 'NarsilError'
  | 'PROTOTYPE_POLLUTION_KEYS'
  | 'assembleFrozenSegment'
  | 'cloneProjected'
  | 'createPartitionIndex'
  | 'decodeSurfaceTable'
  | 'documentWithOwnBuffers'
  | 'getNestedValue'
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
type MsgpackNames = Pick<typeof MsgpackCode, 'Decoder' | 'MAP_TAGS' | 'decode' | 'encodeDocument' | 'headerAt'>

export let ErrorCodes: EngineNames['ErrorCodes']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>
export let PROTOTYPE_POLLUTION_KEYS: EngineNames['PROTOTYPE_POLLUTION_KEYS']
export let assembleFrozenSegment: EngineNames['assembleFrozenSegment']
export let cloneProjected: EngineNames['cloneProjected']
export let createPartitionIndex: EngineNames['createPartitionIndex']
export let decodeSurfaceTable: EngineNames['decodeSurfaceTable']
export let documentWithOwnBuffers: EngineNames['documentWithOwnBuffers']
export let getNestedValue: EngineNames['getNestedValue']
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
export let Decoder: MsgpackNames['Decoder']
export type Decoder = InstanceType<MsgpackNames['Decoder']>
export let MAP_TAGS: MsgpackNames['MAP_TAGS']
export let decode: MsgpackNames['decode']
export let encodeDocument: MsgpackNames['encodeDocument']
export let headerAt: MsgpackNames['headerAt']

export function bindSegmentCodecHost(host: EngineNames, msgpack: MsgpackNames): void {
  ;({
    ErrorCodes,
    NarsilError,
    PROTOTYPE_POLLUTION_KEYS,
    assembleFrozenSegment,
    cloneProjected,
    createPartitionIndex,
    decodeSurfaceTable,
    documentWithOwnBuffers,
    getNestedValue,
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
  ;({ Decoder, MAP_TAGS, decode, encodeDocument, headerAt } = msgpack)
}
