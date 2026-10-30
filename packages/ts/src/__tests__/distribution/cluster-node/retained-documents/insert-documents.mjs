import { setTimeout as sleep } from 'node:timers/promises'
import { createInMemoryCoordinator } from '../../../../../dist/distribution/coordinator/in-memory.mjs'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
} from '../../../../../dist/distribution/transport/in-memory.mjs'
import { createClusterNode } from '../../../../../dist/distribution.mjs'

const [singleInserts, batchCount, retention] = process.argv.slice(2)
const replication = retention === undefined ? undefined : { logRetentionBytes: Number(retention) }
const SINGLE_INSERTS = Number(singleInserts)
const BATCHES = Number(batchCount)
const BATCH_SIZE = 500
const SETTLE_ROUNDS = 4
const SETTLE_PAUSE_MS = 50
const IN_SYNC_POLLS = 400
const IN_SYNC_POLL_MS = 25
const WORDS = ['river', 'stone', 'lamp', 'forest', 'copper', 'ledger', 'harbour', 'signal', 'amber', 'meadow']

function furniture(serial) {
  const body = Array.from({ length: 30 }, (_, index) => WORDS[(serial * 7 + index * 3) % WORDS.length]).join(' ')
  return { title: `Oak chair ${serial}`, body, price: serial % 500 }
}

async function settledArrayBufferBytes() {
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    globalThis.gc()
    await sleep(SETTLE_PAUSE_MS)
  }
  return process.memoryUsage().arrayBuffers
}

const coordinator = createInMemoryCoordinator()
const network = createInMemoryNetwork()
const nodes = []
for (const [nodeId, roles] of [
  ['primary-node', ['data', 'coordinator', 'controller']],
  ['replica-node', ['data']],
]) {
  const node = await createClusterNode({
    coordinator,
    transport: createInMemoryTransport(nodeId, network),
    address: `${nodeId}:9200`,
    nodeId,
    roles,
    engine: { workers: { enabled: false } },
    replication,
  })
  await node.start()
  nodes.push(node)
}
const [primary] = nodes
await primary.createIndex(
  'furniture',
  { schema: { title: 'string', body: 'string', price: 'number' } },
  { partitionCount: 1, replicationFactor: 1, waitForServingMs: 30_000 },
)

let replicaInSync = false
for (let poll = 0; poll < IN_SYNC_POLLS && !replicaInSync; poll++) {
  const table = await coordinator.getAllocation('furniture')
  replicaInSync = [...(table?.assignments.values() ?? [])].every(assignment =>
    assignment.inSyncSet.includes('replica-node'),
  )
  if (!replicaInSync) await sleep(IN_SYNC_POLL_MS)
}
if (!replicaInSync) throw new Error('the replica never joined the in-sync set')

const before = await settledArrayBufferBytes()
let serial = 0
let jsonBytes = 0
for (let count = 0; count < SINGLE_INSERTS; count++) {
  const document = furniture(serial++)
  jsonBytes += Buffer.byteLength(JSON.stringify(document))
  await primary.insert('furniture', document, `chair-${serial}`)
}
for (let batch = 0; batch < BATCHES; batch++) {
  const documents = []
  for (let count = 0; count < BATCH_SIZE; count++) {
    const document = { id: `chair-${serial}`, ...furniture(serial++) }
    jsonBytes += Buffer.byteLength(JSON.stringify(document))
    documents.push(document)
  }
  await primary.insertBatch('furniture', documents)
}
const after = await settledArrayBufferBytes()

process.stdout.write(
  `${JSON.stringify({ documents: serial, arrayBufferBytesPerDocument: (after - before) / serial, jsonBytesPerDocument: jsonBytes / serial })}\n`,
)

for (const node of nodes) await node.shutdown()
await coordinator.shutdown()
process.exit(0)
