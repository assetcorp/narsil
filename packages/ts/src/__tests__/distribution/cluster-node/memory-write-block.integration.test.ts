import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import { clusterNodeEngine } from '../../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator, NodeRegistration } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { NarsilServer } from '../../../server'
import { createServer } from '../../../server'
import { postJson } from '../../server/helpers'

const POLL_INTERVAL_MS = 50
const POLL_BUDGET_MS = 15_000
const FAKE_NODE_ID = 'node-f'
const FAKE_NODE_STARTED_AT = '2026-10-26T09:00:00.000Z'
const FAKE_REGISTRATION_RENEW_MS = 2_000
const GIBIBYTE = 1024 * 1024 * 1024
const MEBIBYTE = 1024 * 1024
const SCHEMA = { title: 'string', price: 'number' } as const

interface RealNode {
  node: ClusterNode
  transport: NodeTransport
}

async function pollUntil(predicate: () => Promise<boolean>): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
}

async function codeOf(work: Promise<unknown>): Promise<string | null> {
  try {
    await work
    return null
  } catch (error) {
    return error instanceof NarsilError ? error.code : String(error)
  }
}

function copyHolders(table: AllocationTable | null): Set<string> {
  const holders = new Set<string>()
  for (const assignment of table?.assignments.values() ?? []) {
    if (assignment.primary !== null) holders.add(assignment.primary)
    for (const replica of assignment.replicas) holders.add(replica)
  }
  return holders
}

function standInRegistration(
  nodeId: string,
  overrides: Partial<Omit<NodeRegistration, 'nodeId'>> = {},
): NodeRegistration {
  return {
    nodeId,
    address: `${nodeId}:9200`,
    roles: ['data'],
    capacity: { memoryBytes: 8 * GIBIBYTE, cpuCores: 4, diskBytes: null },
    startedAt: FAKE_NODE_STARTED_AT,
    version: '1.0',
    ...overrides,
  }
}

function memoryOf(full: boolean): NodeRegistration['memory'] {
  return {
    processBytes: full ? 950 * MEBIBYTE : 100 * MEBIBYTE,
    processLimitBytes: GIBIBYTE,
    heapBytes: 50 * MEBIBYTE,
    heapLimitBytes: GIBIBYTE,
    full,
  }
}

async function startRealNode(
  coordinator: ClusterCoordinator,
  network: ReturnType<typeof createInMemoryNetwork>,
  nodeId: string,
  roles: Array<'data' | 'coordinator' | 'controller'>,
): Promise<RealNode> {
  const transport = createInMemoryTransport(nodeId, network)
  const node = await createClusterNode({
    coordinator,
    transport,
    address: `${nodeId}:9200`,
    nodeId,
    roles,
    engine: { workers: { enabled: false } },
  })
  await node.start()
  return { node, transport }
}

describe('a cluster refuses inserts and updates while a node holding a copy reports full memory', () => {
  let coordinator: ClusterCoordinator
  let nodes: RealNode[]
  let server: NarsilServer
  let base: string
  let standIn: NodeRegistration
  let renewTimer: ReturnType<typeof setInterval>

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    const network = createInMemoryNetwork()
    nodes = [
      await startRealNode(coordinator, network, 'node-a', ['data', 'coordinator', 'controller']),
      await startRealNode(coordinator, network, 'node-b', ['data', 'coordinator']),
    ]
    const entry = nodes[0].node
    await entry.createIndex('catalogue', { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 2 })
    await entry.createIndex('ledger', { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 0 })

    standIn = standInRegistration(FAKE_NODE_ID, { memory: memoryOf(false) })
    await coordinator.registerNode(standIn)
    renewTimer = setInterval(() => {
      void coordinator.registerNode(standIn)
    }, FAKE_REGISTRATION_RENEW_MS)

    server = createServer(clusterNodeEngine(entry), { host: '127.0.0.1', port: 0, cluster: entry.cluster })
    await server.listen()
    base = `http://127.0.0.1:${server.listeningPort}`
  }, 60_000)

  afterEach(async () => {
    clearInterval(renewTimer)
    await server.close()
    for (const { node, transport } of nodes) {
      await node.shutdown()
      await transport.shutdown()
    }
    await coordinator.shutdown()
  })

  async function reportStandIn(full: boolean): Promise<void> {
    standIn = { ...standIn, memory: memoryOf(full) }
    await coordinator.registerNode(standIn)
  }

  it('blocks only the index with a copy on the full node, lets removes and searches through, and lifts once memory falls', async () => {
    const entry = nodes[0].node
    expect(
      await pollUntil(async () => copyHolders(await coordinator.getAllocation('catalogue')).has(FAKE_NODE_ID)),
    ).toBe(true)
    expect(copyHolders(await coordinator.getAllocation('ledger')).has(FAKE_NODE_ID)).toBe(false)

    const expected = new Map<string, { title: string; price: number }>()
    for (let item = 0; item < 6; item++) {
      const document = { title: `walnut chair ${item}`, price: 100 + item }
      await entry.insert('catalogue', document, `chair-${item}`)
      expected.set(`chair-${item}`, document)
    }

    await reportStandIn(true)
    let probes = 0
    expect(
      await pollUntil(async () => {
        const probe = { title: 'probe stool', price: probes }
        const probeId = `probe-${probes++}`
        const code = await codeOf(entry.insert('catalogue', probe, probeId))
        if (code === null) expected.set(probeId, probe)
        return code === ErrorCodes.CLUSTER_WRITE_BLOCKED
      }),
    ).toBe(true)
    const blockedProbeId = `probe-${probes - 1}`

    expect(await codeOf(entry.insert('catalogue', { title: 'oak table', price: 300 }, 'table-1'))).toBe(
      ErrorCodes.CLUSTER_WRITE_BLOCKED,
    )
    expect(await codeOf(entry.insertBatch('catalogue', [{ id: 'table-2', title: 'pine table', price: 250 }]))).toBe(
      ErrorCodes.CLUSTER_WRITE_BLOCKED,
    )
    expect(await codeOf(entry.update('catalogue', 'chair-0', { title: 'renamed chair', price: 1 }))).toBe(
      ErrorCodes.CLUSTER_WRITE_BLOCKED,
    )
    expect(
      await codeOf(entry.updateBatch('catalogue', [{ docId: 'chair-1', document: { title: 'renamed', price: 2 } }])),
    ).toBe(ErrorCodes.CLUSTER_WRITE_BLOCKED)
    expect(await codeOf(nodes[1].node.insert('catalogue', { title: 'beech stool', price: 80 }, 'stool-1'))).toBe(
      ErrorCodes.CLUSTER_WRITE_BLOCKED,
    )

    const refused = await postJson<{ error: { code: string; details: { fullNodeIds: string[] } } }>(
      base,
      '/indexes/catalogue/documents',
      { document: { title: 'elm bench', price: 90 }, id: 'bench-1' },
    )
    expect(refused.status).toBe(429)
    expect(refused.body.error.code).toBe(ErrorCodes.CLUSTER_WRITE_BLOCKED)
    expect(refused.body.error.details.fullNodeIds).toEqual([FAKE_NODE_ID])
    const refusedBatch = await postJson<{ error: { code: string } }>(base, '/indexes/catalogue/documents/_batch', {
      documents: [{ id: 'bench-2', title: 'ash bench', price: 95 }],
    })
    expect(refusedBatch.status).toBe(429)
    expect(refusedBatch.body.error.code).toBe(ErrorCodes.CLUSTER_WRITE_BLOCKED)

    await entry.remove('catalogue', 'chair-5')
    expected.delete('chair-5')
    const removedBatch = await entry.removeBatch('catalogue', ['chair-4'])
    expect(removedBatch.succeeded).toEqual(['chair-4'])
    expected.delete('chair-4')

    await entry.insert('ledger', { title: 'invoice', price: 12 }, 'invoice-1')
    expect(await entry.get('ledger', 'invoice-1')).toEqual({ title: 'invoice', price: 12 })

    expect(await entry.countDocuments('catalogue')).toBe(expected.size)
    const blockedSearch = await entry.query('catalogue', { term: 'chair', limit: 20 })
    const chairIds = [...expected].filter(([, document]) => document.title.split(' ').includes('chair'))
    expect(blockedSearch.hits.map(hit => hit.id).sort()).toEqual(chairIds.map(([docId]) => docId).sort())
    for (const [docId, document] of expected) {
      expect(await entry.get('catalogue', docId)).toEqual(document)
    }
    for (const absent of ['table-1', 'table-2', 'stool-1', 'bench-1', 'bench-2', blockedProbeId]) {
      expect(await entry.has('catalogue', absent)).toBe(false)
    }

    await reportStandIn(false)
    expect(
      await pollUntil(
        async () => (await codeOf(entry.insert('catalogue', { title: 'oak table', price: 300 }, 'table-1'))) === null,
      ),
    ).toBe(true)
    expected.set('table-1', { title: 'oak table', price: 300 })
    await entry.update('catalogue', 'chair-0', { title: 'renamed chair', price: 1 })
    expected.set('chair-0', { title: 'renamed chair', price: 1 })
    const accepted = await postJson(base, '/indexes/catalogue/documents', {
      document: { title: 'elm bench', price: 90 },
      id: 'bench-1',
    })
    expect(accepted.status).toBe(201)
    expected.set('bench-1', { title: 'elm bench', price: 90 })

    expect(await entry.countDocuments('catalogue')).toBe(expected.size)
    for (const [docId, document] of expected) {
      expect(await entry.get('catalogue', docId)).toEqual(document)
    }
  }, 60_000)
})

describe('the controller places copies by the memory that nodes report', () => {
  let coordinator: ClusterCoordinator
  let controller: RealNode
  let standIns: NodeRegistration[]
  let renewTimer: ReturnType<typeof setInterval>

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    controller = await startRealNode(coordinator, createInMemoryNetwork(), 'node-a', ['coordinator', 'controller'])
    standIns = []
    renewTimer = setInterval(() => {
      for (const registration of standIns) void coordinator.registerNode(registration)
    }, FAKE_REGISTRATION_RENEW_MS)
  }, 30_000)

  afterEach(async () => {
    clearInterval(renewTimer)
    await controller.node.shutdown()
    await controller.transport.shutdown()
    await coordinator.shutdown()
  })

  async function register(registration: NodeRegistration): Promise<void> {
    standIns.push(registration)
    await coordinator.registerNode(registration)
  }

  it('skips a full node and a node whose reported partitions leave no room, and sizes a reported partition by its report', async () => {
    await register(
      standInRegistration('node-full', {
        memory: memoryOf(true),
        capacity: { memoryBytes: 64 * GIBIBYTE, cpuCores: 4, diskBytes: null },
      }),
    )
    await register(
      standInRegistration('node-crowded', {
        capacity: { memoryBytes: GIBIBYTE, cpuCores: 4, diskBytes: null },
        partitionBytes: [{ indexName: 'archive', partitions: [[0, 990 * MEBIBYTE]] }],
      }),
    )
    await register(
      standInRegistration('node-roomy', { capacity: { memoryBytes: GIBIBYTE, cpuCores: 4, diskBytes: null } }),
    )

    await controller.node.createIndex(
      'catalogue',
      { schema: SCHEMA },
      { partitionCount: 3, replicationFactor: 0, waitForServingMs: 0 },
    )
    expect(
      await pollUntil(async () => ((await coordinator.getAllocation('catalogue'))?.assignments.size ?? 0) === 3),
    ).toBe(true)
    expect([...copyHolders(await coordinator.getAllocation('catalogue'))]).toEqual(['node-roomy'])

    await controller.node.createIndex(
      'manuals',
      { schema: SCHEMA },
      { partitionCount: 1, replicationFactor: 1, waitForServingMs: 0 },
    )
    expect(
      await pollUntil(async () => ((await coordinator.getAllocation('manuals'))?.assignments.size ?? 0) === 1),
    ).toBe(true)
    const manuals = await coordinator.getAllocation('manuals')
    expect(manuals?.assignments.get(0)?.primary).toBe('node-roomy')
    expect(manuals?.assignments.get(0)?.replicas).toEqual([])

    await register(
      standInRegistration('node-holder', {
        memory: memoryOf(true),
        partitionBytes: [{ indexName: 'manuals', partitions: [[0, 600 * MEBIBYTE]] }],
      }),
    )
    await register(
      standInRegistration('node-compact', { capacity: { memoryBytes: 500 * MEBIBYTE, cpuCores: 4, diskBytes: null } }),
    )
    await register(
      standInRegistration('node-large', { capacity: { memoryBytes: GIBIBYTE, cpuCores: 4, diskBytes: null } }),
    )

    expect(
      await pollUntil(async () => {
        const table = await coordinator.getAllocation('manuals')
        return (table?.assignments.get(0)?.replicas.length ?? 0) === 1
      }),
    ).toBe(true)
    expect((await coordinator.getAllocation('manuals'))?.assignments.get(0)?.replicas).toEqual(['node-large'])
  }, 60_000)
})

describe('a cluster node checks its memory thresholds', () => {
  it.each([
    [{ blockWritesAbove: 0 }],
    [{ blockWritesAbove: 1.5 }],
    [{ blockWritesAbove: Number.NaN }],
    [{ resumeWritesBelow: -0.1 }],
    [{ blockWritesAbove: 0.7 }],
    [{ blockWritesAbove: 0.6, resumeWritesBelow: 0.6 }],
    [{ blockWritesAbove: 0.5, resumeWritesBelow: 0.9 }],
    [{ blockWritesAbove: '0.9' as unknown as number }],
  ])('refuses %o with CONFIG_INVALID', async memory => {
    const coordinator = createInMemoryCoordinator()
    const transport = createInMemoryTransport('node-a', createInMemoryNetwork())
    try {
      expect(
        await codeOf(createClusterNode({ coordinator, transport, address: 'node-a:9200', nodeId: 'node-a', memory })),
      ).toBe(ErrorCodes.CONFIG_INVALID)
    } finally {
      await transport.shutdown()
      await coordinator.shutdown()
    }
  })
})
