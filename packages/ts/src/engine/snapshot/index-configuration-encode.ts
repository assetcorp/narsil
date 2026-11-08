import { encode } from '@msgpack/msgpack'
import {
  configurationPayloadOf,
  ErrorCodes,
  NarsilError,
  packChecksummedEnvelope,
  rulesOfStoredSynonyms,
} from '#platform/storage-host'
import type { IndexRegistryEntry } from '../core'
import { INDEX_CONFIGURATION_ENVELOPE_VERSION } from './index-configuration-decode'

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
  const payload = configurationPayloadOf(
    entry.config,
    entry.language,
    entry.embeddingAdapterName,
    entry.analysisRevision,
    entry.arrayPositionGap,
    synonyms,
    entry.analysisGeneration,
  )
  const withSuggestions = { ...payload, ...entry.querySuggestions }
  return entry.sync === null ? withSuggestions : { ...withSuggestions, syncEpoch: entry.sync.epoch }
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
