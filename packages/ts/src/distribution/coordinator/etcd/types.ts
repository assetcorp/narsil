export interface EtcdCoordinatorConfig {
  endpoints: string[]
  keyPrefix: string
  nodeHeartbeatTtlSeconds: number
  leaseTtlSeconds: number
}

export const DEFAULT_ETCD_CONFIG: EtcdCoordinatorConfig = {
  endpoints: ['http://localhost:2379'],
  keyPrefix: '_narsil',
  nodeHeartbeatTtlSeconds: 30,
  leaseTtlSeconds: 15,
}

export const ETCD_KEY_NODES = 'nodes'
export const ETCD_KEY_ALLOCATION = 'allocation'
export const ETCD_KEY_PARTITION = 'partition'
export const ETCD_KEY_SCHEMA = 'schema'

export function buildKey(prefix: string, ...segments: string[]): string {
  return [prefix, ...segments].join('/')
}
