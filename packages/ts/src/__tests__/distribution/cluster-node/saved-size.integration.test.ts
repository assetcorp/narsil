import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { PartitionStatsResult } from '../../../types/results'
import {
  bodyOf,
  checkpointFileBytes,
  logFileBytes,
  partitionCheckpointFileBytes,
  partitionLogFileBytes,
} from '../../persistence/durability/saved-size-oracle'
import { waitForSettledReplica } from './cluster-harness'

const INDEX = 'articles'
const NODE_IDS = ['node-a', 'node-b', 'node-c']
const PARTITIONS = [0, 1, 2]
const DOCUMENTS = 240

function vectorOf(seed: number): number[] {
  return [Math.sin(seed), Math.cos(seed), Math.sin(seed * 2), Math.cos(seed * 3)]
}

function vectorSharesOf(vectorBytes: number, documentCounts: ReadonlyMap<number, number>): Map<number, number> {
  const ids = [...documentCounts.keys()].sort((left, right) => left - right)
  const documents = ids.reduce((total, id) => total + BigInt(documentCounts.get(id) ?? 0), 0n)
  const shares = new Map<number, number>()
  let given = 0n
  for (const id of ids) {
    const share =
      documents === 0n
        ? BigInt(vectorBytes) / BigInt(ids.length)
        : (BigInt(vectorBytes) * BigInt(documentCounts.get(id) ?? 0)) / documents
    shares.set(id, Number(share))
    given += share
  }
  shares.set(ids[0], (shares.get(ids[0]) ?? 0) + vectorBytes - Number(given))
  return shares
}

describe('the saved size of a cluster index with three copies of every partition', () => {
  let root: string
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  const nodes = new Map<string, ClusterNode>()

  function directoryOf(nodeId: string): string {
    return join(root, nodeId)
  }

  async function startNode(nodeId: string): Promise<ClusterNode> {
    const node = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport(nodeId, network),
      address: `${nodeId}:9200`,
      nodeId,
      roles: ['data', 'coordinator', 'controller'],
      controller: { nodeLeftDelayMs: 0 },
      engine: {
        workers: { enabled: false },
        durability: { directory: directoryOf(nodeId), checkpointIntervalMs: 0 },
      },
    })
    nodes.set(nodeId, node)
    await node.start()
    return node
  }

  function savedOnDisk(nodeId: string, partitionId: number): number {
    return partitionCheckpointFileBytes(directoryOf(nodeId), INDEX, partitionId)
  }

  function vectorBytesOnDisk(nodeId: string): number {
    const segments = PARTITIONS.reduce((total, id) => total + savedOnDisk(nodeId, id), 0)
    return checkpointFileBytes(directoryOf(nodeId), INDEX) - segments
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-cluster-saved-size-'))
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
  })

  afterEach(async () => {
    for (const node of nodes.values()) await node.shutdown()
    nodes.clear()
    await coordinator.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('reports the read copy and every copy from the files on each node, and leaves the every-copy sums out once a copy stops answering', async () => {
    const first = await startNode('node-a')
    await first.createIndex(
      INDEX,
      { schema: { title: 'string', body: 'string', embedding: 'vector[4]' } },
      { partitionCount: PARTITIONS.length, replicationFactor: 2 },
    )
    await startNode('node-b')
    await startNode('node-c')
    await waitForSettledReplica(coordinator, INDEX, 'node-b')
    await waitForSettledReplica(coordinator, INDEX, 'node-c')
    const documents = Array.from({ length: DOCUMENTS }, (_, at) => ({
      id: `article-${at}`,
      title: `title ${at}`,
      body: bodyOf(at, 300),
      embedding: vectorOf(at),
    }))
    expect((await first.insertBatch(INDEX, documents)).failed).toEqual([])
    for (const node of nodes.values()) await node.checkpoint(INDEX)

    const partitions = await first.getPartitionStats(INDEX)
    const documentCounts = new Map(partitions.map(partition => [partition.partitionId, partition.documentCount]))
    expect([...documentCounts.values()].reduce((total, count) => total + count, 0)).toBe(DOCUMENTS)
    for (const nodeId of NODE_IDS) expect(vectorBytesOnDisk(nodeId)).toBeGreaterThan(0)
    const shares = new Map(NODE_IDS.map(nodeId => [nodeId, vectorSharesOf(vectorBytesOnDisk(nodeId), documentCounts)]))

    let readCopyLowest = 0
    let readCopyHighest = 0
    for (const partition of partitions) {
      const copies = NODE_IDS.map(nodeId => savedOnDisk(nodeId, partition.partitionId))
      expect(copies).toContain(partition.savedBytes)
      expect(partition.savedBytesOfEveryCopy).toBe(copies.reduce((total, bytes) => total + bytes, 0))
      expect(partition.logBytesOfEveryCopy).toBe(
        NODE_IDS.reduce(
          (total, nodeId) => total + partitionLogFileBytes(directoryOf(nodeId), INDEX, partition.partitionId),
          0,
        ),
      )
      const withVectors = NODE_IDS.map(
        nodeId => savedOnDisk(nodeId, partition.partitionId) + (shares.get(nodeId)?.get(partition.partitionId) ?? 0),
      )
      readCopyLowest += Math.min(...withVectors)
      readCopyHighest += Math.max(...withVectors)
    }

    const stats = await first.getStats(INDEX)
    expect(stats.savedBytesOfEveryCopy).toBe(
      NODE_IDS.reduce((total, nodeId) => total + checkpointFileBytes(directoryOf(nodeId), INDEX), 0),
    )
    expect(stats.logBytesOfEveryCopy).toBe(
      NODE_IDS.reduce((total, nodeId) => total + logFileBytes(directoryOf(nodeId), INDEX), 0),
    )
    expect(stats.savedBytes).toBeGreaterThanOrEqual(readCopyLowest)
    expect(stats.savedBytes).toBeLessThanOrEqual(readCopyHighest)
    expect(stats.logBytes).toBeGreaterThan(0)

    network.unregister('node-c')
    const afterLoss = await first.getStats(INDEX)
    expect(afterLoss.documentCount).toBe(DOCUMENTS)
    expect(afterLoss.savedBytes).toBeGreaterThan(0)
    expect(afterLoss.savedBytesOfEveryCopy).toBeUndefined()
    expect(afterLoss.logBytesOfEveryCopy).toBeUndefined()
    const partitionsAfterLoss: PartitionStatsResult[] = await first.getPartitionStats(INDEX)
    for (const partition of partitionsAfterLoss) {
      expect(partition.savedBytes).toBeGreaterThan(0)
      expect(partition.savedBytesOfEveryCopy).toBeUndefined()
      expect(partition.logBytesOfEveryCopy).toBeUndefined()
    }
  }, 120_000)

  it('shrinks every copy after half the documents go, and matches the files of the copies left after a primary fails over during the rewrite', async () => {
    const first = await startNode('node-a')
    await first.createIndex(
      INDEX,
      { schema: { title: 'string', body: 'string', embedding: 'vector[4]' } },
      { partitionCount: PARTITIONS.length, replicationFactor: 2 },
    )
    await startNode('node-b')
    await startNode('node-c')
    await waitForSettledReplica(coordinator, INDEX, 'node-b')
    const allocation = await waitForSettledReplica(coordinator, INDEX, 'node-c')
    const documents = Array.from({ length: DOCUMENTS }, (_, at) => ({
      id: `article-${at}`,
      title: `title ${at}`,
      body: bodyOf(at, 300),
      embedding: vectorOf(at),
    }))
    expect((await first.insertBatch(INDEX, documents)).failed).toEqual([])
    for (const node of nodes.values()) await node.checkpoint(INDEX)
    const savedBeforeRemovals = new Map(
      NODE_IDS.map(nodeId => [nodeId, checkpointFileBytes(directoryOf(nodeId), INDEX)]),
    )

    const removed = documents.filter((_, at) => at % 2 === 0).map(document => document.id)
    expect((await first.removeBatch(INDEX, removed)).failed).toEqual([])
    const victim = [...allocation.assignments.values()]
      .map(assignment => assignment.primary)
      .find(primary => primary !== null && primary !== 'node-a')
    if (victim === undefined || victim === null) throw new Error('no primary outside node-a')
    const survivors = NODE_IDS.filter(nodeId => nodeId !== victim)
    const checkpoints = [...nodes.values()].map(node => node.checkpoint(INDEX).catch(() => undefined))
    const leaving = nodes.get(victim)
    nodes.delete(victim)
    await leaving?.shutdown()
    await Promise.all(checkpoints)

    const deadline = Date.now() + 15_000
    for (;;) {
      const table = await coordinator.getAllocation(INDEX)
      const settled =
        table !== null &&
        [...table.assignments.values()].every(
          entry => entry.state === 'ACTIVE' && entry.primary !== null && !entry.replicas.includes(victim),
        )
      if (settled) break
      if (Date.now() > deadline) throw new Error(`the allocation still lists ${victim}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    for (const nodeId of survivors) {
      for (let round = 0; round < 3; round++) await nodes.get(nodeId)?.checkpoint(INDEX)
    }

    expect(await first.countDocuments(INDEX)).toBe(DOCUMENTS - removed.length)
    for (const docId of removed.slice(0, 10)) expect(await first.get(INDEX, docId)).toBeUndefined()
    for (const nodeId of survivors) {
      expect(checkpointFileBytes(directoryOf(nodeId), INDEX)).toBeLessThan(savedBeforeRemovals.get(nodeId) ?? 0)
    }

    const stats = await first.getStats(INDEX)
    expect(stats.savedBytesOfEveryCopy).toBe(
      survivors.reduce((total, nodeId) => total + checkpointFileBytes(directoryOf(nodeId), INDEX), 0),
    )
    expect(stats.logBytesOfEveryCopy).toBe(
      survivors.reduce((total, nodeId) => total + logFileBytes(directoryOf(nodeId), INDEX), 0),
    )
    for (const partition of await first.getPartitionStats(INDEX)) {
      const copies = survivors.map(nodeId => savedOnDisk(nodeId, partition.partitionId))
      expect(copies).toContain(partition.savedBytes)
      expect(partition.savedBytesOfEveryCopy).toBe(copies.reduce((total, bytes) => total + bytes, 0))
    }
  }, 120_000)
})
