import { setTimeout as sleep } from 'node:timers/promises'
import { getHeapStatistics } from 'node:v8'
import { createInMemoryCoordinator } from '../../../../../dist/distribution/coordinator/in-memory.mjs'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
} from '../../../../../dist/distribution/transport/in-memory.mjs'
import { createClusterNode } from '../../../../../dist/distribution.mjs'

const NODE_ID = 'node-1'
const REGISTRATION_POLLS = 200
const REGISTRATION_POLL_MS = 25

const coordinator = createInMemoryCoordinator()
const transport = createInMemoryTransport(NODE_ID, createInMemoryNetwork())
const node = await createClusterNode({
  coordinator,
  transport,
  address: `${NODE_ID}:9200`,
  nodeId: NODE_ID,
  roles: ['data', 'coordinator', 'controller'],
  engine: { workers: { enabled: false } },
})
await node.start()

let memory = null
for (let poll = 0; poll < REGISTRATION_POLLS && memory === null; poll++) {
  const registration = (await coordinator.listNodes()).find(entry => entry.nodeId === NODE_ID)
  memory = registration?.memory ?? null
  if (memory === null) await sleep(REGISTRATION_POLL_MS)
}

const heapSizeLimitBytes = getHeapStatistics().heap_size_limit
process.stdout.write(`${JSON.stringify({ memory, heapSizeLimitBytes })}\n`)

await node.shutdown()
await transport.shutdown()
await coordinator.shutdown()
