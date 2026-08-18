import type { TlsConfig } from '../tcp/types'
import { MAX_MESSAGE_SIZE_BYTES, type TransportConfig } from '../types'

/**
 * How the gRPC transport listens and dials.
 *
 * @public
 */
export interface GrpcTransportConfig extends TransportConfig {
  /** The transport listens on this host. */
  host: string
  /** The transport listens on this port, and 0 asks the system for a free one. */
  port: number
  /** Presenting this makes every connection mutually authenticated TLS. */
  tls?: TlsConfig
}

export const DEFAULT_GRPC_CONFIG: GrpcTransportConfig = {
  host: '0.0.0.0',
  port: 9301,
  connectTimeout: 5_000,
  requestTimeout: 30_000,
  replicationTimeout: 10_000,
  snapshotTimeout: 300_000,
}

const ENVELOPE_OVERHEAD_BYTES = 1_024
const KEEPALIVE_TIME_MS = 30_000
const KEEPALIVE_TIMEOUT_MS = 10_000

export function channelOptions(): Record<string, number> {
  return {
    'grpc.max_receive_message_length': MAX_MESSAGE_SIZE_BYTES + ENVELOPE_OVERHEAD_BYTES,
    'grpc.max_send_message_length': MAX_MESSAGE_SIZE_BYTES + ENVELOPE_OVERHEAD_BYTES,
    'grpc.keepalive_time_ms': KEEPALIVE_TIME_MS,
    'grpc.keepalive_timeout_ms': KEEPALIVE_TIMEOUT_MS,
    'grpc.keepalive_permit_without_calls': 1,
  }
}

/**
 * Reads TLS material the caller gave as text or as bytes into the buffer the
 * gRPC credentials take.
 *
 * @param material - The certificate, key, or authority the caller configured.
 * @returns The same material as a buffer.
 */
export function toCredentialBuffer(material: Buffer | string): Buffer {
  return typeof material === 'string' ? Buffer.from(material) : material
}
