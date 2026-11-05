import type { ReplicationLogEntry } from '../distribution/replication/types'
import type { BM25Params } from '../types/schema'
import type { SynonymRule } from '../types/synonyms'
import { isSyncEpoch } from './epoch'

export const SYNC_SUBPROTOCOL = 'narsil.sync.v1'
export const SYNC_CLOSE_GOING_AWAY = 1001
export const SYNC_CLOSE_POLICY = 1008
export const SYNC_CLOSE_TOO_LARGE = 1009
export const SYNC_CLOSE_SERVER_ERROR = 1011
export const SYNC_CLOSE_CREDENTIAL_EXPIRED = 4401
export const SYNC_CLOSE_RESYNC = 4410
export const MAX_DEVICE_MESSAGE_BYTES = 65_536

export interface SyncPosition {
  partitionId: number
  seqNo: number
}

export interface SyncSettings {
  language: string
  tokenizer?: string
  stopWords?: string
  stopWordList?: string[]
  analysisRevision?: string
  bm25?: BM25Params
  synonyms?: SynonymRule[]
}

export type ResyncReason = 'epoch' | 'history' | 'ahead'

export type DeviceMessage =
  | { type: 'subscribe'; epoch: string; positions: SyncPosition[] }
  | { type: 'ack'; positions: SyncPosition[] }
  | { type: 'checkpoint'; id: number }

export type ServerMessage =
  | {
      type: 'subscribed'
      epoch: string
      partitionCount: number
      heads: SyncPosition[]
      bytesBehind: number
      snapshotBytes: number
      windowBytes: number
      settings: SyncSettings
    }
  | { type: 'entries'; partitionId: number; entries: ReplicationLogEntry[] }
  | { type: 'settings'; settings: SyncSettings }
  | { type: 'checkpoint'; id: number; heads: SyncPosition[] }
  | { type: 'resync'; reason: ResyncReason }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)
}

function isUint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
}

function isSeqNo(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function positionsOf(raw: unknown): SyncPosition[] | null {
  if (!Array.isArray(raw)) return null
  const positions: SyncPosition[] = []
  for (const item of raw) {
    if (!isRecord(item) || !isUint32(item.partitionId) || !isSeqNo(item.seqNo)) return null
    positions.push({ partitionId: item.partitionId, seqNo: item.seqNo })
  }
  return positions
}

export function deviceMessageOf(raw: unknown): DeviceMessage | null {
  if (!isRecord(raw)) return null
  switch (raw.type) {
    case 'subscribe': {
      const positions = positionsOf(raw.positions)
      if (!isSyncEpoch(raw.epoch) || positions === null) return null
      return { type: 'subscribe', epoch: raw.epoch, positions }
    }
    case 'ack': {
      const positions = positionsOf(raw.positions)
      return positions === null ? null : { type: 'ack', positions }
    }
    case 'checkpoint':
      return isUint32(raw.id) ? { type: 'checkpoint', id: raw.id } : null
    default:
      return null
  }
}

export function positionsByPartition(positions: readonly SyncPosition[], partitionCount: number): number[] | null {
  if (positions.length !== partitionCount) return null
  const seqNos = new Array<number>(partitionCount).fill(-1)
  for (const { partitionId, seqNo } of positions) {
    if (partitionId >= partitionCount || seqNos[partitionId] !== -1) return null
    seqNos[partitionId] = seqNo
  }
  return seqNos
}

export function positionList(seqNos: readonly number[]): SyncPosition[] {
  return seqNos.map((seqNo, partitionId) => ({ partitionId, seqNo }))
}
