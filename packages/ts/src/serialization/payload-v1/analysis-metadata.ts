import type { IndexMetadata } from '../../types/internal'

export interface RawAnalysisMetadata {
  tokenizer?: string
  stop_words?: string
  stop_word_list?: string[]
  fold_marks?: unknown
  analysis_generation?: unknown
  pending_analysis?: {
    generation?: unknown
    language?: unknown
    tokenizer?: unknown
    stop_words?: unknown
    stop_word_list?: unknown
    fold_marks?: unknown
  }
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(word => typeof word === 'string')
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function analysisMetadataToWire(meta: IndexMetadata): RawAnalysisMetadata {
  const wire: RawAnalysisMetadata = {}
  if (meta.tokenizer !== undefined) wire.tokenizer = meta.tokenizer
  if (meta.stopWords !== undefined) wire.stop_words = meta.stopWords
  if (meta.stopWordList !== undefined) wire.stop_word_list = meta.stopWordList
  if (meta.foldMarks !== undefined) wire.fold_marks = meta.foldMarks
  if (meta.analysisGeneration !== undefined) wire.analysis_generation = meta.analysisGeneration
  const pending = meta.pendingAnalysis
  if (pending !== undefined) {
    wire.pending_analysis = {
      generation: pending.generation,
      language: pending.language,
      ...(pending.tokenizer !== undefined ? { tokenizer: pending.tokenizer } : {}),
      ...(pending.stopWords !== undefined ? { stop_words: pending.stopWords } : {}),
      ...(pending.stopWordList !== undefined ? { stop_word_list: pending.stopWordList } : {}),
      ...(pending.foldMarks !== undefined ? { fold_marks: pending.foldMarks } : {}),
    }
  }
  return wire
}

export function analysisMetadataFromWire(raw: RawAnalysisMetadata, meta: IndexMetadata): void {
  if (typeof raw.tokenizer === 'string') meta.tokenizer = raw.tokenizer
  if (typeof raw.stop_words === 'string') meta.stopWords = raw.stop_words
  if (isStringList(raw.stop_word_list)) meta.stopWordList = raw.stop_word_list
  if (typeof raw.fold_marks === 'boolean') meta.foldMarks = raw.fold_marks
  if (isPositiveInteger(raw.analysis_generation)) meta.analysisGeneration = raw.analysis_generation
  const pending = raw.pending_analysis
  if (pending && isPositiveInteger(pending.generation) && typeof pending.language === 'string') {
    meta.pendingAnalysis = {
      generation: pending.generation,
      language: pending.language,
      ...(typeof pending.tokenizer === 'string' ? { tokenizer: pending.tokenizer } : {}),
      ...(typeof pending.stop_words === 'string' ? { stopWords: pending.stop_words } : {}),
      ...(isStringList(pending.stop_word_list) ? { stopWordList: pending.stop_word_list } : {}),
      ...(typeof pending.fold_marks === 'boolean' ? { foldMarks: pending.fold_marks } : {}),
    }
  }
}
