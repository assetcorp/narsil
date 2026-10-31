import { decode, encode } from '@msgpack/msgpack'
import { compareCodePoints } from '../../core/ordering'
import { ErrorCodes, NarsilError } from '../../errors'
import { messagePackUpperBoundBytes } from '../../schema/validator/document-size'
import { openChecksummedEnvelope, packChecksummedEnvelope } from '../../serialization/envelope-file'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig } from '../../types/schema'
import type { SynonymRule } from '../../types/synonyms'
import { MAX_INDEX_CONFIGURATION_BYTES } from '../constants'
import type { IndexRegistryEntry } from '../core'
import { rulesOfStoredSynonyms } from '../synonym-sets'
import type { SnapshotEnvelope } from './restore-config'

export const INDEX_CONFIGURATION_ENVELOPE_VERSION = 5

function refuseCode(entry: IndexRegistryEntry): void {
  if (entry.config.tokenizer !== undefined && typeof entry.config.tokenizer !== 'string') {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'A snapshot persists no code, so the index tokenizer must be a name registered with registerTokenizer',
    )
  }
  if (typeof entry.config.stopWords === 'function') {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'A snapshot persists no code, so the index stop words must be a name registered with registerStopWords',
    )
  }
}

export function indexConfigurationOf(entry: IndexRegistryEntry): Record<string, unknown> {
  refuseCode(entry)
  const synonyms = entry.synonyms === null ? undefined : rulesOfStoredSynonyms(entry.synonyms)
  return configurationPayloadOf(
    entry.config,
    entry.language,
    entry.embeddingAdapterName,
    entry.analysisRevision,
    synonyms,
    entry.analysisGeneration,
  )
}

export function requireConfigurationWithinSizeLimit(config: IndexConfig, language: LanguageModule): void {
  const adapter = config.embedding?.adapter
  const payload = configurationPayloadOf(
    config,
    language,
    typeof adapter === 'string' ? adapter : null,
    language.revision,
  )
  if (messagePackUpperBoundBytes(payload) <= MAX_INDEX_CONFIGURATION_BYTES) return
  const bytes = encode(payload).byteLength
  if (bytes <= MAX_INDEX_CONFIGURATION_BYTES) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `The index configuration takes ${bytes} bytes as MessagePack, but an index configuration may take at most ${MAX_INDEX_CONFIGURATION_BYTES}`,
    { bytes, maximum: MAX_INDEX_CONFIGURATION_BYTES },
  )
}

function configurationPayloadOf(
  config: IndexConfig,
  language: LanguageModule,
  adapterName: string | null,
  analysisRevision: string | null,
  synonyms?: SynonymRule[],
  analysisGeneration = 0,
): Record<string, unknown> {
  const bm25 = config.bm25
  return {
    schema: config.schema,
    language: language.name,
    ...(analysisRevision !== null ? { analysisRevision } : {}),
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

export async function encodeIndexConfiguration(entry: IndexRegistryEntry): Promise<Uint8Array> {
  const packed = await packChecksummedEnvelope(
    [encode(indexConfigurationOf(entry))],
    INDEX_CONFIGURATION_ENVELOPE_VERSION,
    'index configuration',
  )
  const bytes = new Uint8Array(packed.byteLength)
  let offset = 0
  for (const chunk of packed.chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export function requireConfigurationShape(raw: unknown, what: string): SnapshotEnvelope {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `The ${what} does not hold an index configuration`)
  }
  const configuration = raw as SnapshotEnvelope
  if (configuration.schema === null || typeof configuration.schema !== 'object') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `The ${what} holds no schema`)
  }
  if (typeof configuration.language !== 'string' || configuration.language.length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `The ${what} holds no language`)
  }
  return configuration
}

export async function decodeIndexConfiguration(bytes: Uint8Array): Promise<SnapshotEnvelope> {
  const { payload } = await openChecksummedEnvelope(bytes, {
    envelopeFormatVersion: INDEX_CONFIGURATION_ENVELOPE_VERSION,
    what: 'index configuration',
    allowsCompression: true,
  })
  let raw: unknown
  try {
    raw = decode(payload)
  } catch {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'The index configuration is not MessagePack')
  }
  return requireConfigurationShape(raw, 'index configuration')
}
