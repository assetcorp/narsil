import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport, type InMemoryNetwork } from '../../../distribution/transport'
import { NarsilError } from '../../../errors'
import { waitForActiveAllocation } from './cluster-harness'

const INDEX_NAME = 'tools'
const PARTITION_COUNT = 4
const TOOLS = Array.from({ length: 40 }, (_, index) => ({ id: `tool-${index}`, title: `brass chisel ${index}` }))
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('a durable cluster node started without a node id', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let directory: string
  const started: ClusterNode[] = []

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    directory = await mkdtemp(join(tmpdir(), 'narsil-stored-node-id-'))
  })

  afterEach(async () => {
    for (const node of started.splice(0)) await node.shutdown().catch(() => {})
    await coordinator.shutdown()
    await rm(directory, { recursive: true, force: true })
  })

  async function startNode(transportName: string): Promise<ClusterNode> {
    const node = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport(`${transportName}:9200`, network),
      address: `${transportName}:9200`,
      roles: ['data', 'coordinator', 'controller'],
      engine: { durability: { directory } },
    })
    started.push(node)
    await node.start()
    return node
  }

  it('comes back under the same id after a full restart and serves every document it held', async () => {
    const first = await startNode('host-a')
    const firstId = first.nodeId
    expect(firstId).toMatch(UUID_V7)
    await first.createIndex(
      INDEX_NAME,
      { schema: { title: 'string' } },
      { partitionCount: PARTITION_COUNT, replicationFactor: 0 },
    )
    await waitForActiveAllocation(coordinator, INDEX_NAME)
    expect((await first.insertBatch(INDEX_NAME, TOOLS)).failed).toEqual([])
    await first.checkpoint(INDEX_NAME)
    await first.shutdown()
    started.splice(0)

    const restarted = await startNode('host-a')
    expect(restarted.nodeId).toBe(firstId)
    await waitForActiveAllocation(coordinator, INDEX_NAME)

    const answer = await restarted.query(INDEX_NAME, { term: 'chisel', limit: 100 })
    expect(answer.coverage.queriedPartitions).toBe(PARTITION_COUNT)
    expect(answer.hits.map(hit => hit.id).sort()).toEqual(TOOLS.map(tool => tool.id).sort())
  }, 60_000)

  it('refuses a second node that points at a directory another node holds', async () => {
    await startNode('host-a')
    const second = createClusterNode({
      coordinator,
      transport: createInMemoryTransport('host-b:9200', network),
      address: 'host-b:9200',
      engine: { durability: { directory } },
    })
    await expect(second).rejects.toBeInstanceOf(NarsilError)
  }, 30_000)

  it('refuses to start from a node id file that something else rewrote', async () => {
    const first = await startNode('host-a')
    await first.shutdown()
    started.splice(0)
    const idFile = (await readdir(directory)).find(name => name.includes('node-id'))
    expect(idFile).toBeDefined()
    await writeFile(join(directory, idFile ?? ''), '../../etc/passwd\n')

    const error = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport('host-a:9200', network),
      address: 'host-a:9200',
      engine: { durability: { directory } },
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('CONFIG_INVALID')
  }, 30_000)
})
