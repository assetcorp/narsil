import { decode, encode } from '@msgpack/msgpack'
import type { IndexMetadataSnapshot } from './index-metadata'
import { type AnalysisFailure, isRecord, type PendingClusterAnalysis } from './index-settings'

function fieldsOf(snapshot: IndexMetadataSnapshot): {
  fields: Record<string, unknown>
  settings: Record<string, unknown>
} {
  const decoded: unknown = decode(snapshot.bytes)
  const fields = isRecord(decoded) ? decoded : {}
  const settings = isRecord(fields.settings) ? fields.settings : { language: snapshot.settings?.language }
  return { fields, settings }
}

function encoded(fields: Record<string, unknown>, settings: Record<string, unknown>): Uint8Array {
  return new Uint8Array(encode({ ...fields, settings }, { ignoreUndefined: true }))
}

export function metadataWithPendingAnalysis(
  snapshot: IndexMetadataSnapshot,
  pending: PendingClusterAnalysis,
): Uint8Array {
  const { fields, settings } = fieldsOf(snapshot)
  return encoded(fields, { ...settings, pendingAnalysis: pending })
}

export function metadataWithoutPendingAnalysis(snapshot: IndexMetadataSnapshot): Uint8Array {
  const { fields, settings } = fieldsOf(snapshot)
  const { pendingAnalysis: _pending, ...rest } = settings
  return encoded(fields, rest)
}

export function metadataPublishingAnalysis(
  snapshot: IndexMetadataSnapshot,
  pending: PendingClusterAnalysis,
): Uint8Array {
  const { fields, settings } = fieldsOf(snapshot)
  const {
    pendingAnalysis: _pending,
    analysisFailure: _failure,
    tokenizer: _tokenizer,
    stopWords: _stopWords,
    stopWordList: _stopWordList,
    ...rest
  } = settings
  return encoded(fields, {
    ...rest,
    language: pending.language,
    analysisGeneration: pending.generation,
    ...(pending.tokenizer !== undefined ? { tokenizer: pending.tokenizer } : {}),
    ...(pending.stopWords !== undefined ? { stopWords: pending.stopWords } : {}),
    ...(pending.stopWordList !== undefined ? { stopWordList: pending.stopWordList } : {}),
  })
}

export function metadataWithAnalysisFailure(snapshot: IndexMetadataSnapshot, failure: AnalysisFailure): Uint8Array {
  const { fields, settings } = fieldsOf(snapshot)
  const { pendingAnalysis: _pending, ...rest } = settings
  return encoded(fields, { ...rest, analysisFailure: failure })
}
