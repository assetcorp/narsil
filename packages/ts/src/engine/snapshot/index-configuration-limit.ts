import {
  encode,
  oversizedConfigurationPayloadOf,
  requireEncodedConfigurationWithinSizeLimit,
} from '#platform/storage-host'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig } from '../../types/schema'

export function requireConfigurationWithinSizeLimit(config: IndexConfig, language: LanguageModule): void {
  const payload = oversizedConfigurationPayloadOf(config, language)
  if (payload !== null) requireEncodedConfigurationWithinSizeLimit(encode(payload).byteLength)
}
