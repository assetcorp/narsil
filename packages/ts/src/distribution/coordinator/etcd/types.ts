import { DEFAULT_ETCD_MAX_REQUEST_BYTES } from './constants'

/**
 * The certificates that {@link createEtcdCoordinator} uses to reach etcd over
 * TLS.
 *
 * @public
 */
export interface EtcdTlsConfig {
  /** The coordinator trusts an etcd member only where its certificate chains to this authority, in PEM form. */
  ca: Buffer | string
  /** The coordinator presents this client certificate, in PEM form, to an etcd that asks for one. Set it together with `key`. */
  cert?: Buffer | string
  /** The private key that matches `cert`, in PEM form. */
  key?: Buffer | string
}

/**
 * The etcd user that {@link createEtcdCoordinator} signs in as.
 *
 * @public
 */
export interface EtcdAuthConfig {
  /** The coordinator signs in under this etcd user name. */
  username: string
  /** The password of that etcd user. */
  password: string
}

/**
 * Configures where {@link createEtcdCoordinator} connects, how long etcd keeps
 * a node's registration, and how large a request the coordinator sends.
 *
 * @public
 */
export interface EtcdCoordinatorConfig {
  /** The coordinator connects to these etcd endpoints. */
  endpoints: string[]
  /** The coordinator writes every key under this prefix, so that one etcd cluster can store several Narsil clusters. */
  keyPrefix: string
  /** etcd keeps a node's registration for this many seconds without a heartbeat, after which peers count the node as gone. */
  nodeHeartbeatTtlSeconds: number
  /**
   * The coordinator sends etcd requests of at most this many bytes, so set it
   * to the `--max-request-bytes` value of every etcd member. The default of
   * 1,572,864 matches the etcd default. The coordinator raises
   * `CONFIG_INVALID` for a write whose request would be larger, and for a
   * write that etcd reports as too large. When this value is more than
   * 524,288 bytes above the etcd setting, a write in that gap can fail at the
   * gRPC layer of etcd, after which the `etcd3` client stops sending requests
   * to that member for five seconds.
   */
  maxRequestBytes: number
  /**
   * Setting this makes the coordinator reach etcd over TLS, so every endpoint
   * has to start with `https://`.
   */
  tls?: EtcdTlsConfig
  /**
   * Setting this makes the coordinator sign in to etcd as this user. The
   * coordinator sends the password over TLS, or over plain HTTP to a loopback
   * address alone, so that the password never crosses a network in clear text.
   */
  auth?: EtcdAuthConfig
}

export const DEFAULT_ETCD_CONFIG: EtcdCoordinatorConfig = {
  endpoints: ['http://localhost:2379'],
  keyPrefix: '_narsil',
  nodeHeartbeatTtlSeconds: 30,
  maxRequestBytes: DEFAULT_ETCD_MAX_REQUEST_BYTES,
}

export const ETCD_KEY_NODES = 'nodes'
export const ETCD_KEY_ALLOCATION = 'allocation'
export const ETCD_KEY_PARTITION = 'partition'
export const ETCD_KEY_SCHEMA = 'schema'

export function buildKey(prefix: string, ...segments: string[]): string {
  return [prefix, ...segments].join('/')
}
