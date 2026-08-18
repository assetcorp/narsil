export interface NodeSpec {
  nodeId: string
  httpPort: number
  tcpPort: number
}

export const NODES: readonly NodeSpec[] = [
  { nodeId: 'node-a', httpPort: 9701, tcpPort: 9301 },
  { nodeId: 'node-b', httpPort: 9702, tcpPort: 9302 },
  { nodeId: 'node-c', httpPort: 9703, tcpPort: 9303 },
]

export const ETCD_ENDPOINT = 'http://127.0.0.1:2379'
export const INDEX_NAME = 'articles'
export const PARTITION_COUNT = 6
export const REPLICATION_FACTOR = 2

export function nodeSpecOf(nodeId: string): NodeSpec {
  const spec = NODES.find(node => node.nodeId === nodeId)
  if (spec === undefined) {
    throw new Error(`Unknown node id '${nodeId}'; expected one of ${NODES.map(node => node.nodeId).join(', ')}`)
  }
  return spec
}
