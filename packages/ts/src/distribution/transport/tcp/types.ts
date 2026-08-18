import type { TransportConfig } from '../types'

/**
 * The certificate material one node presents to its peers.
 *
 * @public
 */
export interface TlsConfig {
  /** This node presents this certificate, in PEM form. */
  cert: Buffer | string
  /** The private key matching the certificate, in PEM form. */
  key: Buffer | string
  /** Peers must chain to this authority. The Node.js default authorities apply when absent. */
  ca?: Buffer | string
  /** Setting this to false accepts an unverified peer, for tests alone. */
  rejectUnauthorized?: boolean
}

/**
 * How the TCP transport listens and dials.
 *
 * @public
 */
export interface TcpTransportConfig extends TransportConfig {
  /** The transport listens on this host. */
  host: string
  /** The transport listens on this port, and 0 asks the system for a free one. */
  port: number
  /** The connection pool holds at most this many outbound connections. */
  maxConnections: number
  /** Presenting this makes every connection mutually authenticated TLS. */
  tls?: TlsConfig
}

export const DEFAULT_TCP_CONFIG: TcpTransportConfig = {
  host: '0.0.0.0',
  port: 9300,
  connectTimeout: 5_000,
  requestTimeout: 30_000,
  replicationTimeout: 10_000,
  snapshotTimeout: 300_000,
  maxConnections: 256,
}

export const LENGTH_PREFIX_BYTES = 4

export const FRAME_TYPE_REQUEST = 0x01
export const FRAME_TYPE_RESPONSE = 0x02
export const FRAME_TYPE_STREAM_CHUNK = 0x03
export const FRAME_TYPE_STREAM_END = 0x04
