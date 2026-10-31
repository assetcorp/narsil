import { resolveIndexAnalysis } from '../../analysis/registry'
import { getLanguage } from '../../languages/registry'
import { resolvePartialWordAnalysis } from '../../partitioning/insert-options'
import type { PartitionManager } from '../../partitioning/manager'
import type { IndexMetadata } from '../../types/internal'
import type { IndexConfig } from '../../types/schema'
import type { IndexRegistryEntry } from '../core'
import { reconstructSchemaFromMetadata } from '../recovery-schema'
import { prepareStoredSynonyms, rulesOfStoredSynonyms } from '../synonym-sets'

export function adoptSavedAnalysis(
  manager: PartitionManager | undefined,
  entry: IndexRegistryEntry,
  metadata: IndexMetadata,
): void {
  const saved = reconstructSchemaFromMetadata(metadata)
  const { tokenizer: _tokenizer, stopWords: _stopWords, ...rest } = entry.config
  const config: IndexConfig = {
    ...rest,
    language: saved.language,
    ...(saved.tokenizer !== undefined ? { tokenizer: saved.tokenizer } : {}),
    ...(saved.stopWords !== undefined ? { stopWords: saved.stopWords } : {}),
  }
  const language = getLanguage(config.language ?? 'english')
  const analysis = resolveIndexAnalysis(config)
  const synonyms = prepareStoredSynonyms(rulesOfStoredSynonyms(entry.synonyms), config, language)
  entry.config = config
  entry.language = language
  entry.analysisGeneration = metadata.analysisGeneration ?? 0
  entry.analysisRevision = metadata.analysisRevision ?? null
  manager?.adoptAnalysis({
    config,
    language,
    analysis,
    partialWordAnalysis: resolvePartialWordAnalysis(config, language, analysis),
    synonyms: synonyms?.lookup ?? null,
  })
}
