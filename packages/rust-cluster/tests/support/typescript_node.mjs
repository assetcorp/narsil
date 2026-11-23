import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, endpoint, keyPrefix, nodeId, roleList, heartbeatTtlSeconds, durabilityDirectory] =
  process.argv.slice(2)
const dist = join(repositoryRoot, 'packages/ts/dist')
const load = path => import(pathToFileURL(join(dist, path)).href)
const { createClusterNode } = await load('distribution.mjs')
const { createEtcdCoordinator } = await load('distribution/coordinator/etcd.mjs')
const { createTcpTransport } = await load('distribution/transport/tcp.mjs')

const { registerLanguage, registerStopWords, registerTokenizer } = await load('index.mjs')

function letterShape(text) {
  const letters = [...text.toLowerCase()]
  const count = wanted => letters.filter(letter => letter === wanted).length
  return Float32Array.from([count('a'), count('o'), letters.length])
}

registerStopWords('fleet-words', new Set(['zebra', 'garage']))
registerTokenizer('pipe-separated', {
  tokenize: text =>
    text
      .split('|')
      .map(part => part.trim().toLowerCase())
      .filter(part => part.length > 0)
      .map((token, position) => ({ token, position })),
})
const embeddingAdapters = {
  'letter-shape': {
    dimensions: 3,
    embed: async text => letterShape(text),
  },
}

const coordinator = await createEtcdCoordinator({
  endpoints: [endpoint],
  keyPrefix,
  ...(heartbeatTtlSeconds === '' ? {} : { nodeHeartbeatTtlSeconds: Number(heartbeatTtlSeconds) }),
})
const transport = createTcpTransport(nodeId, { host: '127.0.0.1', port: 0 })
const stopPlaceholderListener = await transport.listen(() => undefined)
stopPlaceholderListener()
const address = `127.0.0.1:${transport.getPort()}`
const node = await createClusterNode({
  coordinator,
  transport,
  nodeId,
  address,
  roles: roleList.split(','),
  engine: {
    workers: { enabled: false },
    embeddingAdapters,
    ...(durabilityDirectory === '' ? {} : { durability: { directory: durabilityDirectory, mode: 'sync' } }),
  },
})
await node.start()

function batchOutcome(result) {
  return {
    succeeded: result.succeeded,
    failed: result.failed.map(({ docId, error }) => ({ docId, code: error?.code ?? 'UNEXPECTED' })),
  }
}

function withVectors(document, vectorFields = []) {
  const converted = { ...document }
  for (const field of vectorFields) converted[field] = Float32Array.from(converted[field])
  return converted
}

async function indexConfig(schema, config = {}) {
  const { language, stopWords, ...rest } = config
  if (language !== undefined && language !== 'english') {
    registerLanguage((await load(`languages/${language}.mjs`))[language])
  }
  return {
    schema,
    ...rest,
    ...(language === undefined ? {} : { language }),
    ...(stopWords === undefined ? {} : { stopWords: Array.isArray(stopWords) ? new Set(stopWords) : stopWords }),
  }
}

const operations = {
  createIndex: async ({ indexName, schema, partitionCount, replicationFactor, config }) =>
    node.createIndex(indexName, await indexConfig(schema, config), {
      partitionCount,
      replicationFactor,
      waitForServingMs: 30_000,
    }),
  insert: ({ indexName, documentId, document, vectorFields }) =>
    node.insert(indexName, withVectors(document, vectorFields), documentId ?? undefined),
  update: ({ indexName, documentId, document, vectorFields }) =>
    node.update(indexName, documentId, withVectors(document, vectorFields)),
  remove: ({ indexName, documentId }) => node.remove(indexName, documentId),
  dropIndex: ({ indexName }) => node.dropIndex(indexName),
  setReplicationFactor: ({ indexName, replicationFactor }) =>
    node.cluster.setReplicationFactor(indexName, replicationFactor),
  insertBatch: async ({ indexName, documents }) => batchOutcome(await node.insertBatch(indexName, documents)),
  updateBatch: async ({ indexName, updates }) => batchOutcome(await node.updateBatch(indexName, updates)),
  removeBatch: async ({ indexName, documentIds }) => batchOutcome(await node.removeBatch(indexName, documentIds)),
  get: ({ indexName, documentId }) => node.get(indexName, documentId),
  partitionCounts: async ({ indexName }) =>
    (await node.getPartitionStats(indexName)).map(({ partitionId, documentCount }) => ({ partitionId, documentCount })),
  query: async ({ indexName, params }) => {
    const result = await node.query(indexName, params)
    return {
      hits: result.hits.map(hit => ({ id: hit.id, score: hit.score ?? null, document: hit.document ?? null })),
      count: result.count,
      facets: result.facets ?? null,
      coverage: result.coverage,
    }
  },
  countDocuments: ({ indexName }) => node.countDocuments(indexName),
  suggest: ({ indexName, params }) => node.suggest(indexName, params),
  preflight: ({ indexName, params }) => node.preflight(indexName, params),
  listDocuments: async ({ indexName, params }) => {
    const result = await node.listDocuments(indexName, params)
    return { ids: result.documents.map(listed => listed.id), total: result.total, cursor: result.cursor }
  },
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

process.stdout.write(`READY ${address}\n`)
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  perform(JSON.parse(line))
})
lines.on('close', shutdown)
