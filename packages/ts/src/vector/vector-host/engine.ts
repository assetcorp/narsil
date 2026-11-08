import type { OptionalCodeHost } from '../../engine/optional-code-host'

type EngineNames = Pick<
  OptionalCodeHost,
  | 'ErrorCodes'
  | 'NarsilError'
  | 'bindSearchSignal'
  | 'bytesToVectors'
  | 'compareCodePoints'
  | 'createDocIdMap'
  | 'detectRuntime'
  | 'isDead'
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

export let ErrorCodes: EngineNames['ErrorCodes']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>
export let bindSearchSignal: EngineNames['bindSearchSignal']
export let bytesToVectors: EngineNames['bytesToVectors']
export let compareCodePoints: EngineNames['compareCodePoints']
export let createDocIdMap: EngineNames['createDocIdMap']
export let detectRuntime: EngineNames['detectRuntime']
export let isDead: EngineNames['isDead']
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
    ErrorCodes,
    NarsilError,
    bindSearchSignal,
    bytesToVectors,
    compareCodePoints,
    createDocIdMap,
    detectRuntime,
    isDead,
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
