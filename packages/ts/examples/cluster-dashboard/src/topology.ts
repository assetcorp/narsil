export interface ClusterNodeSpec {
  nodeId: string
  httpPort: number
  replicationPort: number
  etcdProxyPort: number
  replicationHost: string
  etcdProxyName: string
  replicationProxyName: string
}

export const INDEX_NAME = 'forum-answers'
export const PARTITION_COUNT = 6
export const REPLICATION_FACTOR = 1
export const ETCD_KEY_PREFIX = '_narsil_dashboard'
export const NODE_HEARTBEAT_TTL_SECONDS = 5
export const CONTROLLER_LEASE_TTL_SECONDS = 5
export const TOXIPROXY_ADMIN_URL = 'http://127.0.0.1:8474'
export const CONTROLLER_LEASE_KEY = '_narsil/controller'
export const ETCD_CLIENT_ENDPOINT = 'http://127.0.0.1:2379'

const NODE_IDS = ['node-a', 'node-b', 'node-c'] as const

export const NODES: readonly ClusterNodeSpec[] = NODE_IDS.map((nodeId, index) => ({
  nodeId,
  httpPort: 9701 + index,
  replicationPort: 9301 + index,
  etcdProxyPort: 4101 + index,
  replicationHost: `toxiproxy-${nodeId}`,
  etcdProxyName: `etcd-${nodeId}`,
  replicationProxyName: `replication-${nodeId}`,
}))

export function nodeSpecOf(nodeId: string): ClusterNodeSpec {
  const spec = NODES.find(node => node.nodeId === nodeId)
  if (spec === undefined) {
    throw new Error(`Unknown node id '${nodeId}'; expected one of ${NODES.map(node => node.nodeId).join(', ')}`)
  }
  return spec
}

export function advertisedAddressOf(spec: ClusterNodeSpec): string {
  return `${spec.replicationHost}:${spec.replicationPort}`
}

export function certificateSansOf(spec: ClusterNodeSpec): string[] {
  return [spec.nodeId, spec.replicationHost, 'localhost']
}

export function nodeHttpUrlOf(spec: ClusterNodeSpec): string {
  return `http://127.0.0.1:${spec.httpPort}`
}
