import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import { openChecksummedEnvelope } from '../../serialization/envelope-codec'
import type { SnapshotEnvelope } from './restore-config'

export const INDEX_CONFIGURATION_ENVELOPE_VERSION = 5

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
