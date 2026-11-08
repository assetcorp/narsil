import { bm25SetsValue } from '../../core/scorer'
import { requireConfigurationWithinSizeLimit } from '../../engine/snapshot/index-configuration'
import { decodeIndexConfiguration } from '../../engine/snapshot/index-configuration-decode'
import { restoredConfigFields, restoredEmbedding } from '../../engine/snapshot/restore-config'
import { prepareConfiguredSynonyms } from '../../engine/synonym-sets'
import { requireSurfaceFormsForPartialFields } from '../../engine/validation'
import { ErrorCodes, NarsilError } from '../../errors'
import { getLanguage } from '../../languages/registry'
import { storedStateOf } from '../../query-suggestions/stored-state'
import { requireCreatableSchema, validateSchema } from '../../schema/validator'
import { validateBM25Params } from '../../search/bm25-params'
import type { StoredQuerySuggestions } from '../../types/internal'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'
import type { SynonymRule } from '../../types/synonyms'
import { type IndexMetadata, putIndexMetadata } from '../cluster/index-metadata'
import { indexSettingsOf, withPartitionCount } from '../cluster/index-settings'
import { deleteSynonymSet, type SynonymSetRef, storeSynonymSet } from '../cluster/synonym-set'
import type { AllocationConstraints, ClusterCoordinator } from '../coordinator/types'

export interface RestoredIndexShape {
  indexName: string
  indexUuid: string
  partitionCount: number
  replicationFactor: number
  constraints: AllocationConstraints
}

function damagedConfig(backupName: string, reason: string): NarsilError {
  return new NarsilError(ErrorCodes.BACKUP_DAMAGED, `The index configuration of backup '${backupName}' ${reason}`, {
    backupName,
  })
}

export interface RestorableConfig {
  config: IndexConfig
  suggestions: StoredQuerySuggestions | null
}

export async function decodeBackupIndexConfig(bytes: Uint8Array, backupName: string): Promise<RestorableConfig> {
  const reject = (message: string): never => {
    throw damagedConfig(backupName, `is invalid: ${message}`)
  }
  try {
    const envelope = await decodeIndexConfiguration(bytes)
    const fields = restoredConfigFields(envelope, reject)
    const embedding = restoredEmbedding(envelope.embedding, reject)
    if (envelope.synonyms !== undefined && !Array.isArray(envelope.synonyms)) reject('synonyms must be a list')
    const config: IndexConfig = {
      schema: validateSchema(envelope.schema as SchemaDefinition),
      language: envelope.language,
      ...fields,
      ...(embedding === undefined ? {} : { embedding }),
      ...(Array.isArray(envelope.synonyms) ? { synonyms: envelope.synonyms as SynonymRule[] } : {}),
    }
    const suggestions = storedStateOf({
      querySuggestions: envelope.querySuggestions,
      bannedQueries: envelope.bannedQueries,
      querySuggestionsSource: envelope.querySuggestionsSource,
    })
    return { config, suggestions }
  } catch (error) {
    if (error instanceof NarsilError && error.code === ErrorCodes.BACKUP_DAMAGED) throw error
    throw damagedConfig(backupName, `is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function requireRestorableConfig(config: IndexConfig, partitionCount: number): void {
  requireCreatableSchema(config.schema)
  requireSurfaceFormsForPartialFields(config.schema, config.surfaceForms)
  if (config.bm25 !== undefined) validateBM25Params(config.bm25, config.schema, ErrorCodes.CONFIG_INVALID)
  const language = getLanguage(config.language ?? 'english')
  requireConfigurationWithinSizeLimit(withPartitionCount(config, partitionCount), language)
  prepareConfiguredSynonyms(config, language)
}

export async function writeRestoredMetadata(
  coordinator: ClusterCoordinator,
  config: IndexConfig,
  shape: RestoredIndexShape,
  suggestions: StoredQuerySuggestions | null = null,
): Promise<boolean> {
  requireRestorableConfig(config, shape.partitionCount)
  const synonyms = prepareConfiguredSynonyms(config, getLanguage(config.language ?? 'english'))
  const setsFieldPairs = config.bm25?.fields !== undefined && bm25SetsValue({ fields: config.bm25.fields })
  const synonymSet = synonyms === null ? null : await storeSynonymSet(coordinator, shape.indexUuid, synonyms.encoded)
  const metadata = metadataOf(config, shape, synonymSet, setsFieldPairs, suggestions)
  const stored = await putIndexMetadata(coordinator, metadata).catch(async (error: unknown) => {
    if (synonymSet !== null) await deleteSynonymSet(coordinator, shape.indexUuid, synonymSet)
    throw error
  })
  if (!stored && synonymSet !== null) await deleteSynonymSet(coordinator, shape.indexUuid, synonymSet)
  return stored
}

function metadataOf(
  config: IndexConfig,
  shape: RestoredIndexShape,
  synonymSet: SynonymSetRef | null,
  setsFieldPairs: boolean,
  suggestions: StoredQuerySuggestions | null,
): IndexMetadata {
  return {
    indexUuid: shape.indexUuid,
    indexName: shape.indexName,
    partitionCount: shape.partitionCount,
    replicationFactor: shape.replicationFactor,
    constraints: shape.constraints,
    settings: {
      ...indexSettingsOf(config),
      ...(synonymSet === null ? {} : { synonyms: synonymSet }),
      ...(setsFieldPairs ? { bm25Revision: 1 } : {}),
      ...suggestions,
    },
  }
}
