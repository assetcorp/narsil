import { decode } from '@msgpack/msgpack'
import { ClientErrorCodes, NarsilError } from '../../errors'
import { isSyncEpoch } from '../epoch'
import type { ResyncReason, SyncPosition, SyncSettings } from '../protocol'
import type { KeptEntry } from './types'

export type FeedMessage =
  | {
      type: 'subscribed'
      epoch: string
      partitionCount: number
      heads: number[]
      bytesBehind: number
      snapshotBytes: number
      windowBytes: number
      settings: SyncSettings
    }
  | { type: 'entries'; partitionId: number; entries: KeptEntry[] }
  | { type: 'settings'; settings: SyncSettings }
  | { type: 'checkpoint'; id: number; heads: number[] }
  | { type: 'resync'; reason: ResyncReason }

const RESYNC_REASONS: ReadonlySet<string> = new Set(['epoch', 'history', 'ahead'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function malformed(detail: string): NarsilError {
  return new NarsilError(ClientErrorCodes.CLIENT_INVALID_RESPONSE, `The sync feed sent a malformed message: ${detail}`)
}

function headsOf(raw: unknown): number[] {
  if (!Array.isArray(raw)) throw malformed('heads must be a list')
  const seqNos = new Array<number>(raw.length).fill(-1)
  for (const item of raw as unknown[]) {
    if (!isRecord(item) || !isCount(item.partitionId) || !isCount(item.seqNo)) throw malformed('a head is invalid')
    if (item.partitionId >= seqNos.length || seqNos[item.partitionId] !== -1) {
      throw malformed('heads must name each partition once')
    }
    seqNos[item.partitionId] = item.seqNo
  }
  return seqNos
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function settingsOf(raw: unknown): SyncSettings {
  if (!isRecord(raw) || typeof raw.language !== 'string') throw malformed('settings need a language')
  const optionalString = (key: string): string | undefined => {
    const value = raw[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') throw malformed(`settings.${key} must be a string`)
    return value
  }
  const tokenizer = optionalString('tokenizer')
  const stopWords = optionalString('stopWords')
  const analysisRevision = optionalString('analysisRevision')
  if (raw.stopWordList !== undefined && raw.stopWordList !== null && !stringList(raw.stopWordList)) {
    throw malformed('settings.stopWordList must be a list of strings')
  }
  if (raw.bm25 !== undefined && raw.bm25 !== null && !isRecord(raw.bm25)) throw malformed('settings.bm25 is invalid')
  if (raw.synonyms !== undefined && raw.synonyms !== null && !Array.isArray(raw.synonyms)) {
    throw malformed('settings.synonyms must be a list')
  }
  return {
    language: raw.language,
    ...(tokenizer !== undefined ? { tokenizer } : {}),
    ...(stopWords !== undefined ? { stopWords } : {}),
    ...(stringList(raw.stopWordList) ? { stopWordList: raw.stopWordList } : {}),
    ...(analysisRevision !== undefined ? { analysisRevision } : {}),
    ...(isRecord(raw.bm25) ? { bm25: raw.bm25 as SyncSettings['bm25'] } : {}),
    ...(Array.isArray(raw.synonyms) ? { synonyms: raw.synonyms as SyncSettings['synonyms'] } : {}),
  }
}

function entriesOf(partitionId: number, raw: unknown): KeptEntry[] {
  if (!Array.isArray(raw)) throw malformed('entries must be a list')
  let previous = -1
  return (raw as unknown[]).map(item => {
    if (!isRecord(item) || !isCount(item.seqNo) || typeof item.documentId !== 'string') {
      throw malformed('an entry is invalid')
    }
    if (item.seqNo <= previous) throw malformed('entries must rise in sequence order')
    if (item.partitionId !== undefined && item.partitionId !== partitionId) {
      throw malformed('an entry belongs to another partition')
    }
    previous = item.seqNo
    if (item.operation === 'DELETE') {
      return { partitionId, seqNo: item.seqNo, documentId: item.documentId, document: null }
    }
    if (item.operation !== 'INDEX' || !(item.document instanceof Uint8Array)) throw malformed('an entry is invalid')
    return { partitionId, seqNo: item.seqNo, documentId: item.documentId, document: item.document }
  })
}

export function decodeFeedMessage(bytes: Uint8Array): FeedMessage {
  let raw: unknown
  try {
    raw = decode(bytes)
  } catch {
    throw malformed('a frame is not MessagePack')
  }
  if (!isRecord(raw)) throw malformed('a frame is not a map')
  switch (raw.type) {
    case 'subscribed': {
      if (!isSyncEpoch(raw.epoch) || !isCount(raw.partitionCount)) throw malformed('subscribed is invalid')
      if (!isCount(raw.bytesBehind) || !isCount(raw.snapshotBytes) || !isCount(raw.windowBytes)) {
        throw malformed('subscribed is invalid')
      }
      const heads = headsOf(raw.heads)
      if (heads.length !== raw.partitionCount) throw malformed('subscribed needs one head for each partition')
      return {
        type: 'subscribed',
        epoch: raw.epoch,
        partitionCount: raw.partitionCount,
        heads,
        bytesBehind: raw.bytesBehind,
        snapshotBytes: raw.snapshotBytes,
        windowBytes: raw.windowBytes,
        settings: settingsOf(raw.settings),
      }
    }
    case 'entries':
      if (!isCount(raw.partitionId)) throw malformed('entries need a partition')
      return { type: 'entries', partitionId: raw.partitionId, entries: entriesOf(raw.partitionId, raw.entries) }
    case 'settings':
      return { type: 'settings', settings: settingsOf(raw.settings) }
    case 'checkpoint':
      if (!isCount(raw.id)) throw malformed('checkpoint needs an id')
      return { type: 'checkpoint', id: raw.id, heads: headsOf(raw.heads) }
    case 'resync':
      if (typeof raw.reason !== 'string' || !RESYNC_REASONS.has(raw.reason)) throw malformed('resync is invalid')
      return { type: 'resync', reason: raw.reason as ResyncReason }
    default:
      throw malformed(`unknown type ${String(raw.type)}`)
  }
}

export function positionsOf(seqNos: readonly number[]): SyncPosition[] {
  return seqNos.map((seqNo, partitionId) => ({ partitionId, seqNo }))
}
