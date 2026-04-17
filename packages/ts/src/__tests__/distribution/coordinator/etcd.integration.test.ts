import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  AllocationEvent,
  AllocationTable,
  ClusterCoordinator,
  NodeEvent,
  NodeRegistration,
  PartitionAssignment,
  SchemaEvent,
} from '../../../distribution/coordinator'
import { createEtcdCoordinator } from '../../../distribution/coordinator'
import type { SchemaDefinition } from '../../../types/schema'

const ETCD_IMAGE = 'gcr.io/etcd-development/etcd:v3.6.0'

interface EtcdContainerHandle {
  endpoint: string
  name: string
}

function makeNodeRegistration(overrides: Partial<NodeRegistration> = {}): NodeRegistration {
  return {
    nodeId: 'node-1',
    address: '127.0.0.1:9200',
    roles: ['data', 'coordinator', 'controller'],
    capacity: { memoryBytes: 8_000_000_000, cpuCores: 4, diskBytes: 100_000_000_000 },
    startedAt: '2026-04-08T10:00:00Z',
    version: '1.0',
    ...overrides,
  }
}

function makeAllocationTable(indexName: string): AllocationTable {
  const assignment: PartitionAssignment = {
    primary: 'node-1',
    replicas: ['node-2'],
    inSyncSet: ['node-2'],
    state: 'ACTIVE',
    primaryTerm: 1,
  }

  return {
    indexName,
    version: 1,
    replicationFactor: 1,
    assignments: new Map([[0, assignment]]),
  }
}

const testSchema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  published: 'boolean',
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = stderr.trim() || stdout.trim() || error.message
        reject(new Error(`${command} ${args.join(' ')} failed: ${detail}`))
        return
      }

      resolve(stdout.trim())
    })
  })
}

async function runDocker(args: string[]): Promise<string> {
  return await runCommand('docker', args)
}

async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()

    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => {
          reject(new Error('Failed to allocate a TCP port for etcd integration tests'))
        })
        return
      }

      const { port } = address
      server.close(error => {
        if (error !== undefined) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

async function eventually(action: () => Promise<void>, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: Error | null = null

  while (Date.now() < deadline) {
    try {
      await action()
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      await sleep(200)
    }
  }

  if (lastError !== null) {
    throw new Error(`${description}: ${lastError.message}`)
  }

  throw new Error(description)
}

async function stopEtcdContainer(containerName: string | null): Promise<void> {
  if (containerName === null) {
    return
  }

  await runDocker(['rm', '--force', containerName]).catch(() => {})
}

async function fetchEtcdLogs(containerName: string): Promise<string> {
  return await runDocker(['logs', containerName]).catch(error => {
    return error instanceof Error ? error.message : String(error)
  })
}

async function waitForEtcdReady(endpoint: string): Promise<void> {
  await eventually(
    async () => {
      const coordinator = await createEtcdCoordinator({
        endpoints: [endpoint],
        keyPrefix: `_narsil_etcd_ready_${randomUUID()}`,
      })

      try {
        await coordinator.listNodes()
      } finally {
        await coordinator.shutdown()
      }
    },
    30_000,
    `Timed out waiting for etcd at ${endpoint}`,
  )
}

async function startEtcdContainer(): Promise<EtcdContainerHandle> {
  const hostPort = await getAvailablePort()
  const name = `narsil-etcd-${randomUUID()}`
  const endpoint = `http://127.0.0.1:${hostPort}`

  await runDocker([
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '-p',
    `127.0.0.1:${hostPort}:2379`,
    '-p',
    '127.0.0.1::2380',
    ETCD_IMAGE,
    '/usr/local/bin/etcd',
    '--name',
    'node1',
    '--data-dir',
    '/etcd-data',
    '--listen-client-urls',
    'http://0.0.0.0:2379',
    '--advertise-client-urls',
    endpoint,
    '--listen-peer-urls',
    'http://0.0.0.0:2380',
    '--initial-advertise-peer-urls',
    'http://127.0.0.1:2380',
    '--initial-cluster',
    'node1=http://127.0.0.1:2380',
  ])

  try {
    await waitForEtcdReady(endpoint)
  } catch (error) {
    const logs = await fetchEtcdLogs(name)
    await stopEtcdContainer(name)
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to start etcd container ${name}: ${detail}\n${logs}`)
  }

  return { endpoint, name }
}

describe('EtcdCoordinator integration', () => {
  let container: EtcdContainerHandle | null = null
  let coordinator: ClusterCoordinator | null = null

  function getCoordinator(): ClusterCoordinator {
    if (coordinator === null) {
      throw new Error('Etcd coordinator test instance is not initialized')
    }

    return coordinator
  }

  beforeAll(async () => {
    await runDocker(['version'])
    container = await startEtcdContainer()
  }, 90_000)

  beforeEach(async () => {
    if (container === null) {
      throw new Error('Etcd integration container is not available')
    }

    coordinator = await createEtcdCoordinator({
      endpoints: [container.endpoint],
      keyPrefix: `_narsil_etcd_integration_${randomUUID()}`,
      nodeHeartbeatTtlSeconds: 5,
      leaseTtlSeconds: 5,
    })
  })

  afterEach(async () => {
    if (coordinator === null) {
      return
    }

    await coordinator.shutdown()
    coordinator = null
  })

  afterAll(async () => {
    if (coordinator !== null) {
      await coordinator.shutdown()
      coordinator = null
    }

    await stopEtcdContainer(container?.name ?? null)
    container = null
  }, 30_000)

  it('registers nodes, lists them, and emits watch events against real etcd', async () => {
    const coordinator = getCoordinator()
    const events: NodeEvent[] = []
    const stopWatching = await coordinator.watchNodes(event => events.push(event))

    try {
      const registration = makeNodeRegistration()
      await coordinator.registerNode(registration)

      await eventually(
        async () => {
          expect(events).toHaveLength(1)
          expect(events[0]?.type).toBe('node_joined')
          expect(events[0]?.nodeId).toBe(registration.nodeId)
          expect(events[0]?.registration).toEqual(registration)
        },
        5_000,
        'Timed out waiting for node_joined watch event',
      )

      const listed = await coordinator.listNodes()
      expect(listed).toHaveLength(1)
      expect(listed[0]?.nodeId).toBe(registration.nodeId)

      await coordinator.deregisterNode(registration.nodeId)

      await eventually(
        async () => {
          expect(events).toHaveLength(2)
          expect(events[1]?.type).toBe('node_left')
          expect(events[1]?.nodeId).toBe(registration.nodeId)
          expect(events[1]?.registration).toBeNull()
        },
        5_000,
        'Timed out waiting for node_left watch event',
      )
    } finally {
      stopWatching()
    }
  }, 20_000)

  it('coordinates leases against real etcd', async () => {
    const coordinator = getCoordinator()

    const firstAcquired = await coordinator.acquireLease('controller-lock', 'node-1', 4_000)
    expect(firstAcquired).toBe(true)

    const secondAcquired = await coordinator.acquireLease('controller-lock', 'node-2', 4_000)
    expect(secondAcquired).toBe(false)

    const renewed = await coordinator.renewLease('controller-lock', 'node-1', 4_000)
    expect(renewed).toBe(true)

    const holderBeforeRelease = await coordinator.getLeaseHolder('controller-lock')
    expect(holderBeforeRelease).toBe('node-1')

    await coordinator.releaseLease('controller-lock')

    const holderAfterRelease = await coordinator.getLeaseHolder('controller-lock')
    expect(holderAfterRelease).toBeNull()

    const acquiredAfterRelease = await coordinator.acquireLease('controller-lock', 'node-2', 4_000)
    expect(acquiredAfterRelease).toBe(true)
  }, 20_000)

  it('executes compare-and-set transactions against real etcd', async () => {
    const coordinator = getCoordinator()
    const original = new Uint8Array([1, 2, 3])
    const updated = new Uint8Array([4, 5, 6])

    const created = await coordinator.compareAndSet('cas-key', null, original)
    expect(created).toBe(true)

    const staleCreate = await coordinator.compareAndSet('cas-key', null, updated)
    expect(staleCreate).toBe(false)

    const wrongExpected = await coordinator.compareAndSet('cas-key', new Uint8Array([9, 9, 9]), updated)
    expect(wrongExpected).toBe(false)

    const updatedResult = await coordinator.compareAndSet('cas-key', original, updated)
    expect(updatedResult).toBe(true)

    const stored = await coordinator.get('cas-key')
    expect(Array.from(stored ?? [])).toEqual(Array.from(updated))
  }, 20_000)

  it('round-trips allocations, partition states, schemas, and watch events against real etcd', async () => {
    const coordinator = getCoordinator()
    const allocationEvents: AllocationEvent[] = []
    const schemaEvents: SchemaEvent[] = []
    const stopAllocationWatch = await coordinator.watchAllocation(event => allocationEvents.push(event))
    const stopSchemaWatch = await coordinator.watchSchemas(event => schemaEvents.push(event))

    try {
      const initialTable = makeAllocationTable('products')
      const created = await coordinator.putAllocation('products', initialTable, null)
      expect(created).toBe(true)

      await eventually(
        async () => {
          expect(allocationEvents).toHaveLength(1)
          expect(allocationEvents[0]?.indexName).toBe('products')
          expect(allocationEvents[0]?.table.version).toBe(1)
        },
        5_000,
        'Timed out waiting for allocation watch event',
      )

      const updatedTable = makeAllocationTable('products')
      updatedTable.version = 2

      const staleUpdate = await coordinator.putAllocation('products', updatedTable, 99)
      expect(staleUpdate).toBe(false)

      const versionedUpdate = await coordinator.putAllocation('products', updatedTable, 1)
      expect(versionedUpdate).toBe(true)

      await eventually(
        async () => {
          expect(allocationEvents).toHaveLength(2)
          expect(allocationEvents[1]?.table.version).toBe(2)
        },
        5_000,
        'Timed out waiting for versioned allocation watch event',
      )

      const allocation = await coordinator.getAllocation('products')
      expect(allocation?.version).toBe(2)
      expect(allocation?.assignments.get(0)?.primary).toBe('node-1')

      await coordinator.putPartitionState('products', 0, 'ACTIVE')
      expect(await coordinator.getPartitionState('products', 0)).toBe('ACTIVE')

      await coordinator.putSchema('products', testSchema)

      await eventually(
        async () => {
          expect(schemaEvents).toHaveLength(1)
          expect(schemaEvents[0]?.type).toBe('schema_created')
          expect(schemaEvents[0]?.indexName).toBe('products')
          expect(schemaEvents[0]?.schema).toEqual(testSchema)
        },
        5_000,
        'Timed out waiting for schema watch event',
      )

      expect(await coordinator.getSchema('products')).toEqual(testSchema)
    } finally {
      stopAllocationWatch()
      stopSchemaWatch()
    }
  }, 20_000)
})
