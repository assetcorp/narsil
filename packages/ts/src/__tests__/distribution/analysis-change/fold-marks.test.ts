import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readIndexMetadataSnapshot } from '../../../distribution/cluster/index-metadata'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport, type InMemoryNetwork } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import { ErrorCodes, NarsilError } from '../../../errors'
import { registerLanguage } from '../../../languages/registry'
import { yoruba } from '../../../languages/yoruba'
import { createFilesystemPersistence } from '../../../persistence/filesystem'
import { foldOracle, generatedDocuments, idsWithWord, YORUBA_WORDS } from '../../integration/folded-matching/oracle'
import { waitFor } from '../../server/helpers'
import { waitForActiveAllocation } from '../cluster-node/cluster-harness'

const INDEX = 'words'
const PARTITIONS = 3
const CORPUS_SIZE = 300
const CORPUS_SEED = 53
const EVERY_HIT = 1_000
const NODE_IDS = ['node-a', 'node-b', 'node-c']
const QUERIES = ['oko', 'ile', 'ore']
const OLDER_NODE_VERSION = '1.5'
const OLDER_NODE_MEMORY_BYTES = 1_000_000_000
const documents = generatedDocuments(CORPUS_SIZE, YORUBA_WORDS, CORPUS_SEED)

describe('changing foldMarks on a cluster index', () => {
  let root: string
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  const nodes = new Map<string, ClusterNode>()
  const transports: NodeTransport[] = []

  function node(nodeId: string): ClusterNode {
    const found = nodes.get(nodeId)
    if (found === undefined) throw new Error(`no node ${nodeId}`)
    return found
  }

  async function startNodes(): Promise<void> {
    for (const [at, nodeId] of NODE_IDS.entries()) {
      const transport = createInMemoryTransport(nodeId, network)
      transports.push(transport)
      const started = await createClusterNode({
        coordinator,
        transport,
        address: `${nodeId}:9200`,
        nodeId,
        roles: at === 0 ? ['data', 'coordinator', 'controller'] : ['data', 'coordinator'],
        backups: { store: createFilesystemPersistence({ directory: join(root, 'store') }), keyPrefix: 'backups' },
        engine: { workers: { enabled: false }, durability: { directory: join(root, nodeId), mode: 'sync' } },
      })
      nodes.set(nodeId, started)
      await started.start()
    }
    await node('node-a').createIndex(
      INDEX,
      { schema: { body: 'string' }, language: 'yoruba' },
      { partitionCount: PARTITIONS, replicationFactor: 1 },
    )
    await waitForActiveAllocation(coordinator, INDEX)
    expect((await node('node-a').insertBatch(INDEX, documents)).failed).toEqual([])
    await waitFor(async () => {
      const table = await coordinator.getAllocation(INDEX)
      const assignments = [...(table?.assignments.values() ?? [])]
      return assignments.every(each => each.replicas.every(replica => each.inSyncSet.includes(replica)))
    })
  }

  async function hitIds(reader: ClusterNode, term: string): Promise<string[]> {
    return (await reader.query(INDEX, { term, limit: EVERY_HIT })).hits.map(hit => hit.id).sort()
  }

  async function expectEveryNode(folds: boolean): Promise<void> {
    for (const nodeId of NODE_IDS) {
      for (const term of QUERIES) {
        const expected = idsWithWord(documents, word => (folds ? foldOracle(word) === term : word === term))
        expect({ nodeId, term, hits: await hitIds(node(nodeId), term) }).toEqual({ nodeId, term, hits: expected })
      }
    }
  }

  async function publishedSettings() {
    return (await readIndexMetadataSnapshot(coordinator, INDEX))?.settings
  }

  beforeAll(() => {
    registerLanguage(yoruba)
  })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-cluster-fold-marks-'))
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
  })

  afterEach(async () => {
    for (const started of [...nodes.values()].reverse()) await started.shutdown()
    nodes.clear()
    for (const transport of transports.splice(0)) await transport.shutdown()
    await coordinator.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('switches folding on every node without rotating the epoch of change capture', async () => {
    await startNodes()
    await node('node-a').updateChanges(INDEX, { enabled: true })
    const epoch = (await publishedSettings())?.syncEpoch
    expect(epoch).toBeDefined()
    await expectEveryNode(true)

    await node('node-b').changeAnalysis(INDEX, { foldMarks: false })
    await expectEveryNode(false)
    expect((await publishedSettings())?.foldMarks).toBe(false)
    expect((await publishedSettings())?.syncEpoch).toBe(epoch)

    await node('node-c').changeAnalysis(INDEX, { foldMarks: null })
    await expectEveryNode(true)
    expect((await publishedSettings())?.foldMarks).toBeUndefined()
    expect((await publishedSettings())?.syncEpoch).toBe(epoch)
  }, 120_000)

  it('refuses a foldMarks change while a node below specification version 1.6 is registered', async () => {
    await startNodes()
    await coordinator.registerNode({
      nodeId: 'node-older',
      address: 'node-older',
      roles: ['coordinator'],
      capacity: { memoryBytes: OLDER_NODE_MEMORY_BYTES, cpuCores: 1, diskBytes: null },
      startedAt: new Date().toISOString(),
      version: OLDER_NODE_VERSION,
    })
    const refusal = await node('node-a')
      .changeAnalysis(INDEX, { foldMarks: false })
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(refusal).toBeInstanceOf(NarsilError)
    expect(refusal).toMatchObject({ code: ErrorCodes.ANALYSIS_CHANGE_NOT_READY, details: { nodeIds: ['node-older'] } })
    expect((await publishedSettings())?.pendingAnalysis).toBeUndefined()
    await expectEveryNode(true)
  }, 120_000)
})
