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
  coordinatorLink: LinkProxy
  errors: NarsilError[]
  started: Promise<void>
  stop(): Promise<void>
}

export interface MemberStorage {
  storage?: string | null
}

export interface LinkedCluster {
  observer: ClusterCoordinator
  start(nodeId: string, roles: ClusterNode['roles'], storage?: MemberStorage): Promise<LinkedMember>
  launch(nodeId: string, roles: ClusterNode['roles'], storage?: MemberStorage): Promise<LinkedMember>
  directoryOf(storage: string): string
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

  function directoryOf(storage: string): string {
    return join(directory, storage)
  }

  async function launch(
    nodeId: string,
    roles: ClusterNode['roles'],
    { storage }: MemberStorage = {},
  ): Promise<LinkedMember> {
    const port = await getAvailablePort()
    const peerLink = await startLinkProxy(new URL(`http://127.0.0.1:${port}`))
    const coordinatorLink = await startLinkProxy(new URL(endpoint))
    const coordinator = await createEtcdCoordinator({ endpoints: [coordinatorLink.endpoint], keyPrefix })
    const transport = createTcpTransport(nodeId, { host: '127.0.0.1', port })
    const errors: NarsilError[] = []
    const durability =
      storage === null ? {} : { durability: { directory: directoryOf(storage ?? nodeId), mode: 'sync' as const } }
    const node = await createClusterNode({
      coordinator,
      transport,
      nodeId,
      address: new URL(peerLink.endpoint).host,
      roles: [...roles],
      controller: { nodeLeftDelayMs: 0 },
      engine: { workers: { enabled: false }, ...durability },
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
      await coordinatorLink.close()
    }
    const started = node.start()
    started.catch(() => undefined)
    const member: LinkedMember = {
      node,
      peerLink,
      coordinatorLink,
      errors,
      started,
      stop() {
        stopping ??= release()
        return stopping
      },
    }
    members.push(member)
    return member
  }

  async function start(nodeId: string, roles: ClusterNode['roles'], storage?: MemberStorage): Promise<LinkedMember> {
    const member = await launch(nodeId, roles, storage)
    await member.started
    return member
  }

  return {
    observer,
    start,
    launch,
    directoryOf,
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
