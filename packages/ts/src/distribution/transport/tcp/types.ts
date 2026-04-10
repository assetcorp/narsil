import type { TransportConfig } from '../types'

export interface TlsConfig {
  cert: Buffer | string
  key: Buffer | string
  ca?: Buffer | string
  rejectUnauthorized?: boolean
}

export interface TcpTransportConfig extends TransportConfig {
  host: string
  port: number
  maxConnections: number
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
