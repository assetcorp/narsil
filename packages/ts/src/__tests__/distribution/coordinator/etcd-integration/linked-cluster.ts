import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClusterNode } from '../../../../distribution/cluster-node'
import type { ClusterNode } from '../../../../distribution/cluster-node/types'
import { createEtcdCoordinator } from '../../../../distribution/coordinator'
import type { ClusterCoordinator, PartitionAssignment } from '../../../../distribution/coordinator/types'
import { createTcpTransport } from '../../../../distribution/transport/tcp'
import { NarsilError } from '../../../../errors'
import { eventually, getAvailablePort } from './fixtures'
import { type LinkProxy, startLinkProxy } from './link-proxy'

export interface LinkedMember {
  node: ClusterNode
  peerLink: LinkProxy
  errors: NarsilError[]
  stop(): Promise<void>
}

export interface LinkedCluster {
  observer: ClusterCoordinator
  start(nodeId: string, roles: ClusterNode['roles']): Promise<LinkedMember>
  waitForPartitions(
    indexName: string,
    accepts: (assignment: PartitionAssignment) => boolean,
    timeoutMs: number,
    description: string,
  ): Promise<PartitionAssignment[]>
  dispose(): Promise<void>
}

export async function createLinkedCluster(endpoint: string): Promise<LinkedCluster> {
  const keyPrefix = `_narsil_linked_cluster_${randomUUID()}`
  const observer = await createEtcdCoordinator({ endpoints: [endpoint], keyPrefix })
  const directory = await mkdtemp(join(tmpdir(), 'narsil-linked-cluster-'))
  const members: LinkedMember[] = []

  async function start(nodeId: string, roles: ClusterNode['roles']): Promise<LinkedMember> {
    const port = await getAvailablePort()
    const peerLink = await startLinkProxy(new URL(`http://127.0.0.1:${port}`))
    const coordinator = await createEtcdCoordinator({ endpoints: [endpoint], keyPrefix })
    const transport = createTcpTransport(nodeId, { host: '127.0.0.1', port })
    const errors: NarsilError[] = []
    const node = await createClusterNode({
      coordinator,
      transport,
      nodeId,
      address: new URL(peerLink.endpoint).host,
      roles: [...roles],
      controller: { nodeLeftDelayMs: 0 },
      engine: { workers: { enabled: false }, durability: { directory: join(directory, nodeId), mode: 'sync' } },
      onError: error => {
        if (error instanceof NarsilError) errors.push(error)
      },
    })
    let stopping: Promise<void> | undefined
    async function release(): Promise<void> {
      await node.shutdown()
      await transport.shutdown()
      await coordinator.shutdown()
      await peerLink.close()
    }
    const member: LinkedMember = {
      node,
      peerLink,
      errors,
      stop() {
        stopping ??= release()
        return stopping
      },
    }
    members.push(member)
    await node.start()
    return member
  }

  return {
    observer,
    start,
    async waitForPartitions(indexName, accepts, timeoutMs, description) {
      let assignments: PartitionAssignment[] = []
      await eventually(
        async () => {
          const table = await observer.getAllocation(indexName)
          assignments = [...(table?.assignments.values() ?? [])]
          if (assignments.length === 0 || !assignments.every(accepts)) {
            throw new Error(JSON.stringify(assignments))
          }
        },
        timeoutMs,
        description,
      )
      return assignments
    },
    async dispose() {
      for (const member of [...members].reverse()) await member.stop().catch(() => undefined)
      await observer.shutdown()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
