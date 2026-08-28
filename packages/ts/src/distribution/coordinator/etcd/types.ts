/**
 * How {@link createEtcdCoordinator} reaches etcd, and how long a node's
 * registration survives there.
 *
 * @public
 */
export interface EtcdCoordinatorConfig {
  /** The coordinator connects to these etcd endpoints. */
  endpoints: string[]
  /** The coordinator writes every key under this prefix, which lets one etcd cluster hold several Narsil clusters. */
  keyPrefix: string
  /** A node's registration survives this many seconds without a heartbeat, after which peers treat the node as gone. */
  nodeHeartbeatTtlSeconds: number
}

export const DEFAULT_ETCD_CONFIG: EtcdCoordinatorConfig = {
  endpoints: ['http://localhost:2379'],
  keyPrefix: '_narsil',
  nodeHeartbeatTtlSeconds: 30,
}

export const ETCD_KEY_NODES = 'nodes'
export const ETCD_KEY_ALLOCATION = 'allocation'
export const ETCD_KEY_PARTITION = 'partition'
export const ETCD_KEY_SCHEMA = 'schema'

export function buildKey(prefix: string, ...segments: string[]): string {
  return [prefix, ...segments].join('/')
}
