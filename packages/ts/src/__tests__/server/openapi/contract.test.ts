import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../../client'
import { createClusterNode } from '../../../distribution/cluster-node'
import { clusterNodeEngine } from '../../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import type { NarsilServer } from '../../../server'
import { createServer } from '../../../server'
import { postJson, startTestServer, type TestServer } from '../helpers'
import {
  ContractChecker,
  type LocatedOperation,
  loadPublishedFile,
  operationsOf,
  publishedFilePath,
  type ReceivedResponse,
} from './contract-checker'
import { type ContractState, INDEX, LIMITED_BYTES, OPERATION_CASES, type Probe } from './operation-cases'

const run = promisify(execFile)

const ROUTES_THAT_NO_ONE_CLIENT_METHOD_COVERS = new Set([
  'health',
  'getClusterTopology',
  'getClusterHealth',
  'getMetrics',
  'getIndexAllocation',
  'setReplicationFactor',
  'writeBatch',
  'importNdjson',
])
const REPEATABLE_OPERATIONS = ['getMultiple', 'listDocuments', 'preflight', 'query', 'suggest']
const FIELD_TYPES_WITH_NO_OPTIONS = [
  'number',
  'boolean',
  'enum',
  'geopoint',
  'number[]',
  'boolean[]',
  'enum[]',
  'verbatim',
  'verbatim:sortable',
  'verbatim[]',
  'verbatim[]:sortable',
]
const TEXT_OPTION_ORDERS = [
  '',
  ':sortable',
  ':pattern',
  ':partial',
  ':sortable:pattern',
  ':pattern:sortable',
  ':sortable:partial',
  ':partial:sortable',
  ':pattern:partial',
  ':partial:pattern',
  ':sortable:pattern:partial',
  ':sortable:partial:pattern',
  ':pattern:sortable:partial',
  ':pattern:partial:sortable',
  ':partial:sortable:pattern',
  ':partial:pattern:sortable',
]
const TASK_POLL_ATTEMPTS = 500
const TASK_POLL_INTERVAL_MS = 20

const document = loadPublishedFile()
const operations = operationsOf(document)
const checker = new ContractChecker(document)

function located(operationId: string): LocatedOperation {
  const found = operations.find(entry => entry.operation.operationId === operationId)
  if (found === undefined) throw new Error(`The file holds no operation ${operationId}`)
  return found
}

async function send(base: string, target: LocatedOperation, probe: Probe): Promise<ReceivedResponse> {
  const path = target.path
    .replace('{name}', encodeURIComponent(probe.name ?? ''))
    .replace('{id}', encodeURIComponent(probe.id ?? ''))
  const url = `${base}${path}${probe.query === undefined ? '' : `?${probe.query}`}`
  const headers: Record<string, string> = {}
  let body: BodyInit | undefined
  if (probe.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(probe.json)
  } else if (probe.raw !== undefined) {
    headers['content-type'] = probe.rawContentType ?? 'application/octet-stream'
    body = Buffer.from(probe.raw)
  }
  const response = await fetch(url, { method: target.method.toUpperCase(), headers, body })
  const bytes = new Uint8Array(await response.arrayBuffer())
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    bytes,
    text: new TextDecoder().decode(bytes),
  }
}

describe('the published OpenAPI file', () => {
  let single: TestServer
  let clusterServer: NarsilServer
  let clusterBase: string
  let coordinator: ClusterCoordinator
  let transport: NodeTransport
  let node: ClusterNode
  let durabilityDirectory: string
  const state: ContractState = {
    taskIdToRead: '',
    snapshot: new Uint8Array(),
    documentExport: new Uint8Array(),
    async startTask() {
      const started = await postJson<{ id: string }>(single.base, `/indexes/${INDEX}/_rebuild-analysis`, {})
      return started.body.id
    },
  }

  async function settleTask(id: string): Promise<void> {
    const getTask = located('getTask')
    for (let attempt = 0; attempt < TASK_POLL_ATTEMPTS; attempt++) {
      const response = await send(single.base, getTask, { id, statuses: [200] })
      checker.checkResponse(getTask.operation, response)
      const record = JSON.parse(response.text) as { status: string; error?: unknown }
      if (record.status === 'failed') throw new Error(`Task ${id} failed: ${JSON.stringify(record.error)}`)
      if (record.status !== 'running') return
      await new Promise(resolve => setTimeout(resolve, TASK_POLL_INTERVAL_MS))
    }
    throw new Error(`Task ${id} never finished`)
  }

  async function exercise(operationId: string, probe: Probe, requestMatchesFile: boolean): Promise<ReceivedResponse> {
    const target = located(operationId)
    if (requestMatchesFile && probe.json !== undefined) checker.checkRequestBody(target.operation, probe.json)
    const base = probe.on === 'cluster' ? clusterBase : single.base
    const response = await send(base, target, probe)
    expect(probe.statuses, `${operationId} answered ${response.status}: ${response.text.slice(0, 500)}`).toContain(
      response.status,
    )
    checker.checkResponse(target.operation, response)
    return response
  }

  beforeAll(async () => {
    durabilityDirectory = await mkdtemp(join(tmpdir(), 'narsil-openapi-'))
    single = await startTestServer(
      { limits: { maxBodyBytes: LIMITED_BYTES, maxImportBytes: LIMITED_BYTES, maxRestoreBytes: LIMITED_BYTES } },
      { workers: { enabled: false }, durability: { directory: durabilityDirectory }, lifecycle: {} },
    )
    coordinator = createInMemoryCoordinator()
    transport = createInMemoryTransport('contract-node', createInMemoryNetwork())
    node = await createClusterNode({
      coordinator,
      transport,
      address: 'contract-node:9200',
      nodeId: 'contract-node',
      roles: ['data', 'coordinator', 'controller'],
    })
    clusterServer = createServer(
      clusterNodeEngine(node, { createIndex: { partitionCount: 1, replicationFactor: 0 } }),
      {
        host: '127.0.0.1',
        port: 0,
        cluster: node.cluster,
      },
    )
    await clusterServer.listen()
    clusterBase = `http://127.0.0.1:${clusterServer.listeningPort}`
  })

  afterAll(async () => {
    await clusterServer.close()
    await node.shutdown()
    await transport.shutdown()
    await coordinator.shutdown()
    await single.stop()
    await rm(durabilityDirectory, { recursive: true, force: true })
  })

  it('describes a starting cluster node as unready, then a serving one as ready', async () => {
    await exercise('isReady', { on: 'cluster', statuses: [503] }, true)
    await node.start()
    await exercise('isReady', { on: 'cluster', statuses: [200] }, true)
    const created = await postJson(clusterBase, '/indexes', { name: INDEX, config: { schema: { title: 'string' } } })
    expect(created.status).toBe(201)
  })

  it('has a contract case for exactly the operations it describes', () => {
    const described = operations.map(entry => entry.operation.operationId).sort()
    expect(Object.keys(OPERATION_CASES).sort()).toEqual(described)
    expect(new Set(described).size).toBe(described.length)
  })

  for (const [operationId, testCase] of Object.entries(OPERATION_CASES)) {
    it(`matches ${operationId} on a valid request and on a malformed or over-limit one`, async () => {
      const valid = await testCase.valid(state)
      for (const probe of [valid, ...(testCase.alsoValid?.() ?? [])]) {
        const answered = await exercise(operationId, probe, true)
        if (answered.status < 400 && answered.contentType === 'application/json') {
          probe.verify?.(JSON.parse(answered.text))
        }
        if (operationId === 'snapshot') state.snapshot = answered.bytes
        if (operationId === 'exportDocuments') state.documentExport = answered.bytes
        if (answered.status === 202 && operationId !== 'cancelTask') {
          const record = JSON.parse(answered.text) as { id: string }
          state.taskIdToRead = record.id
          await settleTask(record.id)
        }
      }
      await exercise(operationId, testCase.hostile(state), false)
    })
  }

  it('marks exactly the five repeatable POST routes', () => {
    const marked = operations
      .filter(entry => entry.operation['x-narsil-repeatable'] === true)
      .map(entry => {
        expect(entry.method).toBe('post')
        return entry.operation.operationId
      })
      .sort()
    expect(marked).toEqual(REPEATABLE_OPERATIONS)
  })

  it('gives each route the name of the client method that covers it', () => {
    const client = createNarsilClient({ url: 'http://127.0.0.1:1' }) as unknown as Record<string, unknown>
    for (const { operation } of operations) {
      if (ROUTES_THAT_NO_ONE_CLIENT_METHOD_COVERS.has(operation.operationId)) continue
      expect(typeof client[operation.operationId], operation.operationId).toBe('function')
    }
  })

  it('lists every field type that the server accepts and refuses what it leaves out', async () => {
    const schema = document.components.schemas.FieldType as {
      anyOf: Array<{ enum?: string[]; pattern?: string }>
    }
    const listed = new Set(schema.anyOf.flatMap(entry => entry.enum ?? []))
    const accepted = [
      ...FIELD_TYPES_WITH_NO_OPTIONS,
      ...TEXT_OPTION_ORDERS.flatMap(options => [`string${options}`, `string[]${options}`]),
    ]
    expect([...listed].sort()).toEqual([...accepted].sort())
    const vectorPattern = new RegExp(schema.anyOf.find(entry => entry.pattern !== undefined)?.pattern ?? '$^')
    expect(vectorPattern.test('vector[3]')).toBe(true)
    expect(vectorPattern.test('vector[0]')).toBe(false)

    const checks = [...accepted, 'vector[3]'].map(async (type, at) => {
      const created = await postJson(single.base, '/indexes', {
        name: `field-type-${at}`,
        config: { schema: { value: type } },
      })
      expect(created.status, type).toBe(201)
    })
    await Promise.all(checks)
    for (const type of ['vector[0]', 'number:sortable', 'text']) {
      const refused = await postJson(single.base, '/indexes', {
        name: 'field-type-refused',
        config: { schema: { value: type } },
      })
      expect(refused.status, type).toBe(400)
    }
  })

  it('leaves the reducer out of what the file describes', () => {
    const { schemas } = document.components
    const group = (schemas.HttpQueryParams as { properties: { group: { properties: object } } }).properties.group
    expect(Object.keys(group.properties)).not.toContain('reduce')
    expect(Object.keys((schemas.HttpGroupResult as { properties: object }).properties)).not.toContain('reduced')
  })

  it('reaches a caller through the npm package', async () => {
    const packageDirectory = dirname(publishedFilePath())
    const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: packageDirectory })
    const [packed] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>
    expect(packed?.files.map(file => file.path)).toContain('openapi.json')
  })
})
