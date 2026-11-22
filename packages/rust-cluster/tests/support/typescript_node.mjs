import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, endpoint, keyPrefix, nodeId, roleList, port, heartbeatTtlSeconds] = process.argv.slice(2)
const dist = join(repositoryRoot, 'packages/ts/dist')
const load = path => import(pathToFileURL(join(dist, path)).href)
const { createClusterNode } = await load('distribution.mjs')
const { createEtcdCoordinator } = await load('distribution/coordinator/etcd.mjs')
const { createTcpTransport } = await load('distribution/transport/tcp.mjs')

const coordinator = await createEtcdCoordinator({
  endpoints: [endpoint],
  keyPrefix,
  ...(heartbeatTtlSeconds === undefined ? {} : { nodeHeartbeatTtlSeconds: Number(heartbeatTtlSeconds) }),
})
const transport = createTcpTransport(nodeId, { host: '127.0.0.1', port: Number(port) })
const node = await createClusterNode({
  coordinator,
  transport,
  nodeId,
  address: `127.0.0.1:${port}`,
  roles: roleList.split(','),
  engine: { workers: { enabled: false } },
})
await node.start()

function batchOutcome(result) {
  return {
    succeeded: result.succeeded,
    failed: result.failed.map(({ docId, error }) => ({ docId, code: error?.code ?? 'UNEXPECTED' })),
  }
}

const { registerLanguage } = await load('index.mjs')

async function indexConfig(schema, config = {}) {
  const { language, stopWords, ...rest } = config
  if (language !== undefined && language !== 'english') {
    registerLanguage((await load(`languages/${language}.mjs`))[language])
  }
  return {
    schema,
    ...rest,
    ...(language === undefined ? {} : { language }),
    ...(stopWords === undefined ? {} : { stopWords: new Set(stopWords) }),
  }
}

const operations = {
  createIndex: async ({ indexName, schema, partitionCount, replicationFactor, config }) =>
    node.createIndex(indexName, await indexConfig(schema, config), {
      partitionCount,
      replicationFactor,
      waitForServingMs: 30_000,
    }),
  insert: ({ indexName, documentId, document }) => node.insert(indexName, document, documentId ?? undefined),
  update: ({ indexName, documentId, document }) => node.update(indexName, documentId, document),
  remove: ({ indexName, documentId }) => node.remove(indexName, documentId),
  insertBatch: async ({ indexName, documents }) => batchOutcome(await node.insertBatch(indexName, documents)),
  updateBatch: async ({ indexName, updates }) => batchOutcome(await node.updateBatch(indexName, updates)),
  removeBatch: async ({ indexName, documentIds }) => batchOutcome(await node.removeBatch(indexName, documentIds)),
  get: ({ indexName, documentId }) => node.get(indexName, documentId),
  partitionCounts: async ({ indexName }) =>
    (await node.getPartitionStats(indexName)).map(({ partitionId, documentCount }) => ({ partitionId, documentCount })),
}

function answer(id, outcome) {
  process.stdout.write(`${JSON.stringify({ id, ...outcome })}\n`)
}

async function perform(request) {
  const operation = operations[request.op]
  if (operation === undefined) return answer(request.id, { ok: false, code: 'UNKNOWN_OPERATION' })
  try {
    const value = await operation(request)
    answer(request.id, { ok: true, value: value ?? null })
  } catch (error) {
    answer(request.id, { ok: false, code: error?.code ?? 'UNEXPECTED', message: String(error?.message ?? error) })
  }
}

async function shutdown() {
  await node.shutdown()
  await transport.shutdown()
  await coordinator.shutdown()
  process.exit(0)
}

process.stdout.write('READY\n')
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  perform(JSON.parse(line))
})
lines.on('close', shutdown)
