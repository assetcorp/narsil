import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTROLLER_LEASE_KEY } from '../../../distribution/cluster/controller/types'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator, NodeRegistration } from '../../../distribution/coordinator/types'
import { createForwardMessage } from '../../../distribution/replication/codec'
import type { InMemoryNetwork, NodeTransport } from '../../../distribution/transport'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  ReplicationMessageTypes,
  type TransportMessage,
} from '../../../distribution/transport'
import { ErrorCodes } from '../../../errors'

const LEASE_TTL_MS = 60_000

function forwardedInsert(): TransportMessage {
  return createForwardMessage(
    {
      indexName: 'shop',
      documentId: 'item-1',
      operation: 'insert',
      document: encode({ title: 'portable grinder' }),
      updateFields: null,
    },
    'peer',
  )
}

function insyncAdd(): TransportMessage {
  return {
    type: ReplicationMessageTypes.INSYNC_ADD,
    sourceId: 'peer',
    requestId: 'insync-add-1',
    payload: encode({
      indexName: 'shop',
      partitionId: 0,
      replicaNodeId: 'peer',
      primaryTerm: 1,
      appliedSeqNo: 0,
      commitPoint: 0,
    }),
  }
}

function errorCodeOf(response: TransportMessage): string | undefined {
  const decoded = decode(response.payload) as { error?: boolean; code?: string }
  return decoded.error === true ? decoded.code : undefined
}

describe('what a peer receives from a node that has yet to join', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeTransport: NodeTransport
  let peerTransport: NodeTransport
  let node: ClusterNode
  let releaseRegistration: () => void
  let registrationRequested: Promise<void>

  beforeEach(async () => {
    const backing = createInMemoryCoordinator()
    const registrationGate = new Promise<void>(resolve => {
      releaseRegistration = resolve
    })
    let markRequested: () => void = () => undefined
    registrationRequested = new Promise<void>(resolve => {
      markRequested = resolve
    })
    coordinator = {
      ...backing,
      async registerNode(registration: NodeRegistration) {
        markRequested()
        await registrationGate
        return backing.registerNode(registration)
      },
    }
    network = createInMemoryNetwork()
    nodeTransport = createInMemoryTransport('node-a', network, { requestTimeout: 500 })
    peerTransport = createInMemoryTransport('peer', network, { requestTimeout: 500 })
    node = await createClusterNode({
      coordinator,
      transport: nodeTransport,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator'],
    })
  })

  afterEach(async () => {
    releaseRegistration()
    await node.shutdown()
    await nodeTransport.shutdown()
    await peerTransport.shutdown()
    await coordinator.shutdown()
  })

  it('answers NODE_NOT_READY while the node is still registering, then serves once it has joined', async () => {
    const starting = node.start()
    await registrationRequested

    const refused = await peerTransport.send('node-a', forwardedInsert())
    expect(refused.type).toBe(`${ReplicationMessageTypes.FORWARD}.error`)
    expect(errorCodeOf(refused)).toBe(ErrorCodes.NODE_NOT_READY)

    releaseRegistration()
    await starting

    const served = await peerTransport.send('node-a', forwardedInsert())
    expect(errorCodeOf(served)).not.toBe(ErrorCodes.NODE_NOT_READY)
  })
})

describe('what a peer receives from a data-only node', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeTransport: NodeTransport
  let peerTransport: NodeTransport
  let node: ClusterNode

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    nodeTransport = createInMemoryTransport('node-a', network, { requestTimeout: 500 })
    peerTransport = createInMemoryTransport('peer', network, { requestTimeout: 500 })
    node = await createClusterNode({
      coordinator,
      transport: nodeTransport,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data'],
    })
    await node.start()
  })

  afterEach(async () => {
    await node.shutdown()
    await nodeTransport.shutdown()
    await peerTransport.shutdown()
    await coordinator.shutdown()
  })

  it('answers a controller message with NODE_NOT_CONTROLLER', async () => {
    const refused = await peerTransport.send('node-a', insyncAdd())

    expect(refused.type).toBe(`${ReplicationMessageTypes.INSYNC_ADD}.error`)
    expect(errorCodeOf(refused)).toBe(ErrorCodes.NODE_NOT_CONTROLLER)
  })
})

describe('what a peer receives from a controller-capable node that holds no lease', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeTransport: NodeTransport
  let peerTransport: NodeTransport
  let node: ClusterNode

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    expect(await coordinator.acquireLease(CONTROLLER_LEASE_KEY, 'elsewhere', LEASE_TTL_MS)).toBe(true)
    network = createInMemoryNetwork()
    nodeTransport = createInMemoryTransport('node-a', network, { requestTimeout: 500 })
    peerTransport = createInMemoryTransport('peer', network, { requestTimeout: 500 })
    node = await createClusterNode({
      coordinator,
      transport: nodeTransport,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'controller'],
    })
    await node.start()
  })

  afterEach(async () => {
    await node.shutdown()
    await nodeTransport.shutdown()
    await peerTransport.shutdown()
    await coordinator.shutdown()
  })

  it('answers a controller message with NODE_NOT_CONTROLLER', async () => {
    expect(node.cluster.isControllerActive()).toBe(false)

    const refused = await peerTransport.send('node-a', insyncAdd())

    expect(refused.type).toBe(`${ReplicationMessageTypes.INSYNC_ADD}.error`)
    expect(errorCodeOf(refused)).toBe(ErrorCodes.NODE_NOT_CONTROLLER)
  })
})
