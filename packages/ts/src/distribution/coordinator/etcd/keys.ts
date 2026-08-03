import {
  buildKey,
  ETCD_KEY_ALLOCATION,
  ETCD_KEY_NODES,
  ETCD_KEY_PARTITION,
  ETCD_KEY_SCHEMA,
  type EtcdCoordinatorConfig,
} from './types'

const ETCD_KEY_LEASE = 'lease'
const ETCD_KEY_GENERIC = 'kv'

export interface CoordinatorKeys {
  node(nodeId: string): string
  nodePrefix(): string
  allocation(indexName: string): string
  allocationPrefix(): string
  partition(indexName: string, partitionId: number): string
  schema(indexName: string): string
  schemaPrefix(): string
  lease(key: string): string
  generic(key: string): string
}

export function coordinatorKeys(config: EtcdCoordinatorConfig): CoordinatorKeys {
  const prefix = config.keyPrefix
  return {
    node: (nodeId: string) => buildKey(prefix, ETCD_KEY_NODES, nodeId),
    nodePrefix: () => buildKey(prefix, ETCD_KEY_NODES),
    allocation: (indexName: string) => buildKey(prefix, ETCD_KEY_ALLOCATION, indexName),
    allocationPrefix: () => buildKey(prefix, ETCD_KEY_ALLOCATION),
    partition: (indexName: string, partitionId: number) =>
      buildKey(prefix, ETCD_KEY_PARTITION, indexName, String(partitionId)),
    schema: (indexName: string) => buildKey(prefix, ETCD_KEY_SCHEMA, indexName),
    schemaPrefix: () => buildKey(prefix, ETCD_KEY_SCHEMA),
    lease: (key: string) => buildKey(prefix, ETCD_KEY_LEASE, key),
    generic: (key: string) => buildKey(prefix, ETCD_KEY_GENERIC, key),
  }
}

export function extractSuffix(fullKey: string, prefix: string): string {
  return fullKey.slice(prefix.length + 1)
}
