import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { createInMemoryCoordinator } from '../../../../../dist/distribution/coordinator/in-memory.mjs'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
} from '../../../../../dist/distribution/transport/in-memory.mjs'
import { createClusterNode } from '../../../../../dist/distribution.mjs'

const directory = process.env.NARSIL_WAL_DIR
if (directory === undefined) throw new Error('Missing durability directory')
const prior = process.env.NARSIL_PRIOR_CHECKPOINT === '1'
const failedPartition = prior ? 0 : 1
const healthyId = prior ? 'b' : 'a'
const coordinator = createInMemoryCoordinator()
const network = createInMemoryNetwork()
const index = 'ledger'

async function waitUntil(check) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await check()) return
    await setTimeout(20)
  }
  throw new Error('The checkpoint did not reach the crash boundary')
}

async function start(nodeId, engine, roles) {
  const node = await createClusterNode({
    coordinator,
    transport: createInMemoryTransport(nodeId, network),
    address: nodeId,
    nodeId,
    roles,
    engine,
  })
  await node.start()
  return node
}

const controller = await start('controller', { workers: { enabled: false } }, ['controller', 'coordinator'])
const primary = await start(
  'writer',
  {
    workers: { enabled: false },
    durability: { directory, mode: 'sync', checkpointIntervalMs: 0, checkpointMutationThreshold: 3 },
  },
  ['data', 'coordinator'],
)
await controller.createIndex(
  index,
  { schema: { title: 'string', amount: 'number' } },
  { partitionCount: 2, replicationFactor: 0 },
)
await waitUntil(async () => {
  const table = await coordinator.getAllocation(index)
  return table?.assignments.size === 2 && [...table.assignments.values()].every(entry => entry.state === 'ACTIVE')
})
await primary.insert(index, { title: 'river', amount: 1 }, 'a')
await primary.insert(index, { title: 'shore', amount: 2 }, 'b')
const manifest = join(directory, index, 'manifest')
if (prior) await primary.checkpoint(index)
const previous = await readFile(manifest).catch(() => null)
assert.equal(previous === null, !prior)
if (prior) await primary.update(index, 'a', { title: 'river', amount: 5 })
await mkdir(join(directory, index, 'wal', String(failedPartition), 'next'))
for (let at = 0; at < 3; at++) await primary.update(index, healthyId, { title: 'forest', amount: 3 })
await waitUntil(async () => {
  try {
    await primary.checkpoint(index)
    return false
  } catch (error) {
    if (error.code !== 'PERSISTENCE_SAVE_FAILED') throw error
    return true
  }
})
await primary.update(index, healthyId, { title: 'lake', amount: 4 })
await waitUntil(async () => {
  const bytes = await readFile(manifest).catch(() => null)
  if (bytes !== null && (previous === null || !bytes.equals(previous))) return true
  await primary.update(index, healthyId, { title: 'lake', amount: 4 })
  return false
})
process.stdout.write('ACKED\n')
await new Promise(() => setInterval(() => undefined, 60_000))
