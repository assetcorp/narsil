import { encode } from '@msgpack/msgpack'
import { decode } from '../../serialization/msgpack'
import { newSyncEpoch } from '../../sync/epoch'
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
    foldMarks,
    ...rest
  } = settings
  const termsChange =
    settings.language !== pending.language ||
    settings.tokenizer !== pending.tokenizer ||
    settings.stopWords !== pending.stopWords ||
    !sameWords(settings.stopWordList, pending.stopWordList)
  const capturesHistory =
    (isRecord(rest.sync) && rest.sync.enabled === true) || (isRecord(rest.changes) && rest.changes.enabled === true)
  return encoded(fields, {
    ...rest,
    language: pending.language,
    analysisGeneration: pending.generation,
    ...(pending.tokenizer !== undefined ? { tokenizer: pending.tokenizer } : {}),
    ...(pending.stopWords !== undefined ? { stopWords: pending.stopWords } : {}),
    ...(pending.stopWordList !== undefined ? { stopWordList: pending.stopWordList } : {}),
    ...(pending.foldMarks !== undefined ? { foldMarks: pending.foldMarks } : {}),
    ...(capturesHistory && (termsChange || foldMarks === pending.foldMarks)
      ? { syncActive: false, syncEpoch: newSyncEpoch() }
      : {}),
  })
}

function sameWords(left: unknown, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return Array.isArray(left) && left.length === right.length && left.every((word, at) => word === right[at])
}

export function metadataWithAnalysisFailure(snapshot: IndexMetadataSnapshot, failure: AnalysisFailure): Uint8Array {
  const { fields, settings } = fieldsOf(snapshot)
  const { pendingAnalysis: _pending, ...rest } = settings
  return encoded(fields, { ...rest, analysisFailure: failure })
}
