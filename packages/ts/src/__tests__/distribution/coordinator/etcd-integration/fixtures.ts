import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import type { AllocationTable, NodeRegistration, PartitionAssignment } from '../../../../distribution/coordinator'
import { createEtcdCoordinator } from '../../../../distribution/coordinator'
import type { SchemaDefinition } from '../../../../types/schema'

export const ETCD_IMAGE = 'gcr.io/etcd-development/etcd:v3.6.0'
export const MANAGED_ETCD_ENDPOINT = process.env.NARSIL_ETCD_ENDPOINT?.trim() || null

export interface EtcdContainerHandle {
  endpoint: string
  name: string | null
}

export function makeNodeRegistration(overrides: Partial<NodeRegistration> = {}): NodeRegistration {
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

export function makeAllocationTable(indexName: string): AllocationTable {
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

export const testSchema: SchemaDefinition = {
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

export async function runDocker(args: string[]): Promise<string> {
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

export async function eventually(action: () => Promise<void>, timeoutMs: number, description: string): Promise<void> {
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

export async function stopEtcdContainer(containerName: string | null): Promise<void> {
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

export async function waitForEtcdReady(endpoint: string): Promise<void> {
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

export async function startEtcdContainer(): Promise<EtcdContainerHandle> {
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
