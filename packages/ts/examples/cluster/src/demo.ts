import { type ChildProcess, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEtcdCoordinator } from '@delali/narsil/distribution/coordinator/etcd'
import { ETCD_ENDPOINT, INDEX_NAME, NODES, nodeSpecOf } from './topology.js'

const exampleDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const startedAt = Date.now()

function log(message: string): void {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6)
  console.log(`[demo ${elapsed}s] ${message}`)
}

function baseOf(nodeId: string): string {
  return `http://127.0.0.1:${nodeSpecOf(nodeId).httpPort}`
}

async function pollUntil(label: string, budgetMs: number, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out after ${budgetMs}ms waiting for ${label}`)
}

async function httpJson<T>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: (text.length > 0 ? JSON.parse(text) : undefined) as T }
}

async function pollForCount(label: string, nodeId: string, expected: number): Promise<void> {
  let lastSeen = -1
  await pollUntil(label, 60_000, async () => {
    const result = await httpJson<{ count?: number }>('POST', `${baseOf(nodeId)}/indexes/${INDEX_NAME}/search`, {
      term: 'falconry',
      limit: 5,
    })
    const count = result.status === 200 ? (result.body.count ?? 0) : -result.status
    if (count !== lastSeen) {
      lastSeen = count
      log(`${nodeId} answers ${count} of ${expected}`)
    }
    return count === expected
  })
}

function startNode(nodeId: string): ChildProcess {
  const child = spawn(join(exampleDir, 'node_modules', '.bin', 'tsx'), ['src/node.ts'], {
    cwd: exampleDir,
    env: { ...process.env, NODE_ID: nodeId },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  child.stdout?.on('data', chunk => process.stdout.write(String(chunk)))
  child.stderr?.on('data', chunk => process.stderr.write(String(chunk)))
  return child
}

function killNodeGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch (_) {
    child.kill(signal)
  }
}

const coordinator = await createEtcdCoordinator({
  endpoints: [process.env.ETCD_ENDPOINT ?? ETCD_ENDPOINT],
  keyPrefix: '_narsil_example',
})

const children = new Map<string, ChildProcess>()
for (const node of NODES) {
  children.set(node.nodeId, startNode(node.nodeId))
}

try {
  for (const node of NODES) {
    await pollUntil(`${node.nodeId} to serve HTTP`, 30_000, async () => {
      const health = await fetch(`${baseOf(node.nodeId)}/health`)
      return health.ok
    })
  }
  log('all three nodes serve HTTP')

  const created = await httpJson('POST', `${baseOf('node-a')}/indexes`, {
    name: INDEX_NAME,
    config: { schema: { title: 'string', body: 'string', category: 'enum' } },
  })
  if (created.status !== 201) throw new Error(`createIndex answered ${created.status}`)
  log(`created '${INDEX_NAME}' through node-a`)

  await pollUntil('every partition to reach ACTIVE with its full replica set in sync', 60_000, async () => {
    const allocation = await coordinator.getAllocation(INDEX_NAME)
    if (allocation === null || allocation.assignments.size === 0) return false
    for (const assignment of allocation.assignments.values()) {
      if (assignment.state !== 'ACTIVE') return false
      if (assignment.inSyncSet.length < 1 + assignment.replicas.length) return false
    }
    return true
  })
  log('every partition is ACTIVE with its full replica set in sync')

  const documents = Array.from({ length: 30 }, (_, i) => ({
    id: `article-${String(i).padStart(2, '0')}`,
    title: `Falconry piece ${i}`,
    body: `Notes on training bird number ${i}`,
    category: i % 2 === 0 ? 'training' : 'gear',
  }))
  const batch = await httpJson<{ succeeded: string[] }>(
    'POST',
    `${baseOf('node-a')}/indexes/${INDEX_NAME}/documents/_batch`,
    { documents },
  )
  if (batch.body.succeeded?.length !== documents.length) {
    throw new Error(`batch insert stored ${batch.body.succeeded?.length} of ${documents.length}`)
  }
  log(`ingested ${documents.length} documents through node-a`)

  await pollForCount('node-b to answer the full corpus', 'node-b', documents.length)
  log('node-b answers the full corpus')

  const read = await httpJson<{ document: { title: string } }>(
    'GET',
    `${baseOf('node-c')}/indexes/${INDEX_NAME}/documents/article-07`,
  )
  if (read.status !== 200) throw new Error(`document read through node-c answered ${read.status}`)
  log(`node-c reads article-07: '${read.body.document.title}'`)

  log('killing node-a, the node that ingested everything')
  const nodeA = children.get('node-a')
  if (nodeA !== undefined) killNodeGroup(nodeA, 'SIGKILL')
  children.delete('node-a')

  await pollUntil('the cluster to fail over away from node-a', 120_000, async () => {
    const allocation = await coordinator.getAllocation(INDEX_NAME)
    if (allocation === null) return false
    for (const assignment of allocation.assignments.values()) {
      if (assignment.primary === 'node-a' || assignment.state !== 'ACTIVE') return false
    }
    return true
  })
  log('every partition has a new ACTIVE primary on node-b or node-c')

  await pollForCount('node-b to answer the full corpus after failover', 'node-b', documents.length)
  log('node-b answers the full corpus after failover')

  const readAfter = await httpJson<{ document: { title: string } }>(
    'GET',
    `${baseOf('node-c')}/indexes/${INDEX_NAME}/documents/article-08`,
  )
  if (readAfter.status !== 200) throw new Error(`post-failover read answered ${readAfter.status}`)
  log(`node-c reads article-08 after failover: '${readAfter.body.document.title}'`)

  log('demo complete: ingest on one node, search on another, survive losing the ingest node')
} finally {
  for (const child of children.values()) {
    killNodeGroup(child, 'SIGTERM')
  }
  await coordinator.shutdown()
}
process.exit(0)
