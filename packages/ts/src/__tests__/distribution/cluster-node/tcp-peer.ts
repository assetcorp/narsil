import { createServer } from 'node:net'
import { decode } from '@msgpack/msgpack'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createTcpTransport, type NodeTransport, type TransportMessage } from '../../../distribution/transport'

const IPV6_LOOPBACK = '::1'
const REQUEST_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 3_000

async function freeIpv6LoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, IPV6_LOOPBACK, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('The system offered no TCP port on the IPv6 loopback')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

export interface TcpNodeWithPeer {
  coordinator: ClusterCoordinator
  node: ClusterNode
  peer: NodeTransport
  target: string
  shutdown(): Promise<void>
}

export async function startTcpNodeWithPeer(): Promise<TcpNodeWithPeer> {
  const port = await freeIpv6LoopbackPort()
  const target = `[${IPV6_LOOPBACK}]:${port}`
  const coordinator = createInMemoryCoordinator()
  const nodeTransport = createTcpTransport('node-a', {
    host: IPV6_LOOPBACK,
    port,
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
  })
  const node = await createClusterNode({
    coordinator,
    transport: nodeTransport,
    address: target,
    nodeId: 'node-a',
    roles: ['data', 'coordinator', 'controller'],
    engine: { workers: { enabled: false } },
  })
  await node.start()
  const peer = createTcpTransport('peer', {
    host: IPV6_LOOPBACK,
    port: 0,
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
  })
  return {
    coordinator,
    node,
    peer,
    target,
    async shutdown() {
      await node.shutdown()
      await nodeTransport.shutdown()
      await peer.shutdown()
      await coordinator.shutdown()
    },
  }
}

let sentRequests = 0

export function peerRequest(type: string, payload: Uint8Array): TransportMessage {
  sentRequests += 1
  return { type, sourceId: 'peer', requestId: `peer-request-${sentRequests}`, payload }
}

export function replyBody(response: TransportMessage | Uint8Array): Record<string, unknown> {
  const decoded: unknown = decode(response instanceof Uint8Array ? response : response.payload)
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('The node answered with a payload that is not a MessagePack map')
  }
  return decoded as Record<string, unknown>
}
