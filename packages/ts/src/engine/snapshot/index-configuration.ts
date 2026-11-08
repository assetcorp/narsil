import { ARRAY_POSITION_GAP } from '../../core/constants'
import { compareCodePoints } from '../../core/ordering'
import { ErrorCodes, NarsilError } from '../../errors'
import { messagePackUpperBoundBytes } from '../../schema/validator/document-size'
import { loadedMessagePack, loadMessagePack } from '../../serialization/msgpack-code'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig } from '../../types/schema'
import type { SynonymRule } from '../../types/synonyms'
import { MAX_INDEX_CONFIGURATION_BYTES } from '../constants'

export function oversizedConfigurationPayloadOf(
  config: IndexConfig,
  language: LanguageModule,
): Record<string, unknown> | null {
  const adapter = config.embedding?.adapter
  const payload = configurationPayloadOf(
    config,
    language,
    typeof adapter === 'string' ? adapter : null,
    language.revision,
    ARRAY_POSITION_GAP,
  )
  return messagePackUpperBoundBytes(payload) <= MAX_INDEX_CONFIGURATION_BYTES ? null : payload
}

export function requireEncodedConfigurationWithinSizeLimit(bytes: number): void {
  if (bytes <= MAX_INDEX_CONFIGURATION_BYTES) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `The index configuration takes ${bytes} bytes as MessagePack, but an index configuration may take at most ${MAX_INDEX_CONFIGURATION_BYTES}`,
    { bytes, maximum: MAX_INDEX_CONFIGURATION_BYTES },
  )
}

export function configurationWithinSizeLimit(config: IndexConfig, language: LanguageModule): Promise<void> | null {
  const payload = oversizedConfigurationPayloadOf(config, language)
  if (payload === null) return null
  const code = loadedMessagePack()
  if (code !== null) {
    requireEncodedConfigurationWithinSizeLimit(code.encode(payload).byteLength)
    return null
  }
  return loadMessagePack().then(loaded => requireEncodedConfigurationWithinSizeLimit(loaded.encode(payload).byteLength))
}

export function configurationPayloadOf(
  config: IndexConfig,
  language: LanguageModule,
  adapterName: string | null,
  analysisRevision: string | null,
  arrayPositionGap: number | null,
  synonyms?: SynonymRule[],
  analysisGeneration = 0,
): Record<string, unknown> {
  const bm25 = config.bm25
  return {
    schema: config.schema,
    language: language.name,
    ...(analysisRevision !== null ? { analysisRevision } : {}),
    ...(arrayPositionGap !== null ? { arrayPositionGap } : {}),
    ...(typeof config.tokenizer === 'string' ? { tokenizer: config.tokenizer } : {}),
    ...(typeof config.stopWords === 'string' ? { stopWords: config.stopWords } : {}),
    ...(config.stopWords instanceof Set ? { stopWordList: [...config.stopWords].sort(compareCodePoints) } : {}),
    ...(analysisGeneration > 0 ? { analysisGeneration } : {}),
    ...(bm25 !== undefined
      ? {
          bm25: {
            ...(bm25.k1 !== undefined ? { k1: bm25.k1 } : {}),
            ...(bm25.b !== undefined ? { b: bm25.b } : {}),
            ...(bm25.fields !== undefined ? { fields: bm25.fields } : {}),
          },
        }
      : {}),
    surfaceForms: config.surfaceForms !== false,
    ...(config.partitions !== undefined ? { partitionConfig: config.partitions } : {}),
    ...(config.defaultScoring !== undefined ? { defaultScoring: config.defaultScoring } : {}),
    ...(config.trackPositions !== undefined ? { trackPositions: config.trackPositions } : {}),
    ...(config.textStorage !== undefined ? { textStorage: config.textStorage } : {}),
    ...(config.strict !== undefined ? { strict: config.strict } : {}),
    ...(config.required !== undefined ? { required: config.required } : {}),
    ...(config.vectorPromotion !== undefined ? { vectorPromotion: config.vectorPromotion } : {}),
    ...(config.patternValueLimit !== undefined ? { patternValueLimit: config.patternValueLimit } : {}),
    ...(synonyms !== undefined ? { synonyms } : {}),
    ...(config.embedding !== undefined
      ? {
          embedding: {
            fields: config.embedding.fields,
            ...(adapterName !== null ? { adapter: adapterName } : {}),
          },
        }
      : {}),
  }
}
