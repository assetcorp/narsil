import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, base, token] = process.argv.slice(2)
const { createNarsilClient } = await import(pathToFileURL(join(repositoryRoot, 'packages/ts/dist/client.mjs')).href)
const client = createNarsilClient({ url: base, apiKey: token })

const INDEX = 'walk'
const COPY = 'walk-copy'
const IMPORTED = 'walk-imported'
const LOADED = 'walk-loaded'
const DOCUMENTS = 60
const WORDS = ['zorblat', 'quindle', 'mavrik', 'tessaly', 'brondo', 'ulvane']
const TASK_DEADLINE_MS = 120_000

const steps = []

function record(step, value) {
  steps.push({ step, value })
}

async function attempt(step, call, project = value => value) {
  try {
    const value = await call()
    record(step, { ok: project(value) })
    return value
  } catch (error) {
    record(step, { error: error?.code ?? 'UNKNOWN', status: error?.status ?? null })
    return undefined
  }
}

function corpus() {
  return Array.from({ length: DOCUMENTS }, (_, index) => {
    const words = [WORDS[index % WORDS.length], WORDS[(index * 5 + 1) % WORDS.length]]
    if (index % 4 === 0) words.push(WORDS[(index + 3) % WORDS.length])
    const angle = (index / DOCUMENTS) * Math.PI
    return {
      id: `d${String(index).padStart(2, '0')}`,
      title: words.join(' '),
      year: 2000 + (index % 7),
      embedding: [Math.cos(angle), Math.sin(angle), (index % 3) / 3],
    }
  })
}

function idsHolding(documents, word) {
  return documents
    .filter(document => document.title.split(' ').includes(word))
    .map(document => document.id)
    .sort()
}

function cosine(left, right) {
  const dot = left.reduce((sum, value, index) => sum + value * right[index], 0)
  const norm = vector => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return dot / (norm(left) * norm(right))
}

function nearest(documents, vector, k) {
  return documents
    .map(document => ({ id: document.id, score: cosine(document.embedding, vector) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, k)
    .map(hit => hit.id)
}

const scored = result => result.hits.map(hit => [hit.id, hit.score])
const sortedIds = result => result.hits.map(hit => hit.id).sort()
const taskShape = task =>
  task ? { type: task.type, status: task.status, index: task.indexName ?? null, error: task.error?.code ?? null } : null

async function finished(task) {
  if (task === undefined) return undefined
  return client.waitForTask(task.id, { waitTimeoutMs: TASK_DEADLINE_MS })
}

async function bytesOf(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

const documents = corpus()
let live = documents.map(document => ({ ...document }))

await attempt('alive', () => client.isAlive())
await attempt('ready', () => client.isReady())
await attempt(
  'capabilities',
  () => client.capabilities(),
  list => [...list].sort(),
)
await attempt('supports sync', () => client.supports('sync'))
await attempt(
  'version name',
  () => client.version(),
  version => version.name,
)

await attempt('create', () =>
  client.createIndex(INDEX, {
    schema: { title: 'string', year: 'number', embedding: 'vector[3]' },
    language: 'english',
  }),
)
await attempt('create again', () => client.createIndex(INDEX, { schema: { title: 'string' } }))
await attempt(
  'list indexes',
  () => client.listIndexes(),
  list => list.map(entry => entry.name).sort(),
)

await attempt('insert one', () => client.insert(INDEX, documents[0], documents[0].id))
await attempt(
  'insert batch',
  () => client.insertBatch(INDEX, documents.slice(1)),
  result => ({
    succeeded: result.succeeded.length,
    failed: result.failed.length,
  }),
)
await attempt('insert malformed', () => client.insert(INDEX, { id: 'bad', title: 'x', year: 'not a number' }))

const counted = await attempt('count', () => client.countDocuments(INDEX))
assert.equal(counted, DOCUMENTS, 'the server counts every inserted document')

const fetched = await attempt('get', () => client.get(INDEX, 'd03'))
assert.deepEqual(
  { title: fetched?.title, year: fetched?.year },
  { title: documents[3].title, year: documents[3].year },
  'the server returns the inserted document',
)
await attempt('has', () => client.has(INDEX, 'd03'))
await attempt('has missing', () => client.has(INDEX, 'missing'))
await attempt(
  'get missing',
  () => client.get(INDEX, 'missing'),
  value => value ?? null,
)

await attempt('put', () => client.put(INDEX, 'd01', { ...documents[1], title: 'brondo brondo' }))
live = live.map(document => (document.id === 'd01' ? { ...document, title: 'brondo brondo' } : document))
await attempt('update', () => client.update(INDEX, 'd02', { ...documents[2], title: 'ulvane tessaly' }))
live = live.map(document => (document.id === 'd02' ? { ...document, title: 'ulvane tessaly' } : document))
const updated = await attempt(
  'get updated',
  () => client.get(INDEX, 'd02'),
  value => value?.title ?? null,
)
assert.equal(updated?.title, 'ulvane tessaly', 'the update reaches the stored document')
await attempt('remove', () => client.remove(INDEX, 'd04'))
live = live.filter(document => document.id !== 'd04')
await attempt('remove missing', () => client.remove(INDEX, 'missing'))
await attempt(
  'get multiple',
  () => client.getMultiple(INDEX, ['d00', 'd04', 'd05']),
  found => [...found.keys()].sort(),
)
await attempt(
  'update batch',
  () => client.updateBatch(INDEX, [{ docId: 'd06', document: { ...documents[6], year: 1999 } }]),
  result => ({
    succeeded: result.succeeded.length,
    failed: result.failed.length,
  }),
)
live = live.map(document => (document.id === 'd06' ? { ...document, year: 1999 } : document))
await attempt(
  'remove batch',
  () => client.removeBatch(INDEX, ['d07', 'missing']),
  result => ({
    succeeded: result.succeeded.length,
    failed: result.failed.map(failure => failure.error?.code ?? null),
  }),
)
live = live.filter(document => document.id !== 'd07')
await attempt('wait for writes', () => client.waitForWrites(INDEX))

for (const word of WORDS) {
  const found = await attempt(`search ${word}`, () => client.query(INDEX, { term: word, limit: 100 }), scored)
  assert.deepEqual(sortedIds(found), idsHolding(live, word), `the hits for ${word} are the documents holding it`)
  assert.equal(found.count, idsHolding(live, word).length, `the count for ${word} matches the documents holding it`)
}
const filtered = await attempt(
  'search filtered',
  () => client.query(INDEX, { term: 'zorblat', filters: { fields: { year: { gte: 2003 } } }, limit: 100 }),
  sortedIds,
)
assert.deepEqual(
  sortedIds(filtered),
  live
    .filter(document => document.title.split(' ').includes('zorblat') && document.year >= 2003)
    .map(document => document.id)
    .sort(),
  'the filter keeps only the matching years',
)
const probe = [0.2, 0.9, 0.1]
const vectorHits = await attempt(
  'search vector',
  () => client.query(INDEX, { mode: 'vector', vector: { field: 'embedding', value: probe }, limit: 5 }),
  result => result.hits.map(hit => hit.id),
)
assert.deepEqual(
  vectorHits?.hits.map(hit => hit.id),
  nearest(live, probe, 5),
  'the vector hits are the exact nearest neighbours',
)
await attempt(
  'search hybrid',
  () => client.query(INDEX, { term: 'mavrik', vector: { field: 'embedding', value: probe }, limit: 5 }),
  scored,
)
await attempt(
  'search sorted',
  () => client.query(INDEX, { term: 'quindle', sort: { year: 'desc' }, limit: 100 }),
  result => result.hits.map(hit => hit.id),
)
await attempt(
  'search grouped',
  () => client.query(INDEX, { term: 'tessaly', group: { fields: ['year'], maxPerGroup: 2 }, limit: 100 }),
  result => (result.groups ?? []).map(group => [group.values, group.hits.map(hit => hit.id)]),
)
await attempt(
  'search facets',
  () => client.query(INDEX, { term: 'brondo', facets: { year: {} }, limit: 1 }),
  result => result.facets ?? null,
)
await attempt('search past the window', () => client.query(INDEX, { term: 'zorblat', limit: 1_000_000 }))
await attempt(
  'preflight',
  () => client.preflight(INDEX, { term: 'ulvane' }),
  result => result.count,
)
await attempt(
  'suggest',
  () => client.suggest(INDEX, { prefix: 'zor' }),
  result => result.terms ?? result,
)

const listed = []
let cursor
let pages = 0
do {
  const page = await attempt(
    `list page ${pages}`,
    () => client.listDocuments(INDEX, { limit: 10, cursor }),
    result => ({
      ids: result.documents.map(document => document.id),
      total: result.total,
      more: result.cursor !== null,
    }),
  )
  if (page === undefined) break
  listed.push(...page.documents.map(document => document.id))
  cursor = page.cursor ?? undefined
  pages += 1
} while (cursor !== undefined && pages < DOCUMENTS)
assert.deepEqual(listed.sort(), live.map(document => document.id).sort(), 'the listing walks every live document')

await attempt(
  'stats',
  () => client.getStats(INDEX),
  stats => stats.documentCount,
)
await attempt(
  'partition stats',
  () => client.getPartitionStats(INDEX),
  list => list.length,
)
await attempt(
  'memory stats',
  () => client.getMemoryStats(),
  stats => Object.keys(stats).sort(),
)
await attempt('checkpoint', () => client.checkpoint(INDEX))

const archive = await attempt(
  'snapshot',
  async () => bytesOf(await client.snapshot(INDEX)),
  bytes => bytes.length > 0,
)
if (archive !== undefined) {
  await attempt('restore', async () => finished(await client.restore(COPY, new Uint8Array(archive))), taskShape)
  const copied = await attempt('restored count', () => client.countDocuments(COPY))
  assert.equal(copied, live.length, 'the restored copy holds every live document')
}
const exported = await attempt(
  'export',
  async () => bytesOf(await client.exportDocuments(INDEX)),
  bytes => bytes.toString('utf8').trim().split('\n').length,
)
if (exported !== undefined) {
  await attempt(
    'import export',
    async () => finished(await client.importDocumentExport(IMPORTED, new Uint8Array(exported))),
    taskShape,
  )
  const imported = await attempt('imported count', () => client.countDocuments(IMPORTED))
  assert.equal(imported, live.length, 'the imported copy holds every live document')
}

await attempt('create load target', () => client.createIndex(LOADED, { schema: { title: 'string', year: 'number' } }))
const lines = documents.map(document => JSON.stringify({ id: document.id, title: document.title, year: document.year }))
await attempt(
  'import inline',
  () => client.importDocuments(LOADED, `${lines.join('\n')}\n{broken\n`),
  result => ({
    indexed: result.indexed,
    failed: result.failed,
    errors: (result.errors ?? []).length,
  }),
)
await attempt('import task', async () => finished(await client.startImport(LOADED, lines.join('\n'))), taskShape)
const loaded = await attempt('loaded count', () => client.countDocuments(LOADED))
assert.equal(loaded, DOCUMENTS, 'the import loads every well-formed line once')

await attempt(
  'vector maintenance',
  () => client.vectorMaintenanceStatus(INDEX),
  list => list.map(entry => entry.fieldName),
)
await attempt('compact vectors', () => client.compactVectors(INDEX, 'embedding'))
await attempt('optimize vectors', async () => finished(await client.optimizeVectors(INDEX, 'embedding')), taskShape)
await attempt('rebalance', async () => finished(await client.rebalance(INDEX, 2)), taskShape)
await attempt('partition config', () => client.updatePartitionConfig(INDEX, { maxPartitions: 8 }))
await attempt('synonyms', () => client.updateSynonyms(INDEX, [{ words: ['zorblat', 'brondo'] }]))
await attempt('read synonyms', () => client.getSynonyms(INDEX))
await attempt('rebuild analysis', async () => finished(await client.rebuildAnalysis(INDEX)), taskShape)
await attempt(
  'change analysis',
  async () => finished(await client.changeAnalysis(INDEX, { language: 'english' })),
  taskShape,
)
const afterAnalysis = await attempt('count after analysis', () => client.countDocuments(INDEX))
assert.equal(afterAnalysis, live.length, 'the analysis tasks keep every document')

await attempt(
  'sync status',
  () => client.getSync(INDEX),
  status => status.enabled ?? status,
)
await attempt('sync on', () => client.updateSync(INDEX, { enabled: true }))
await attempt(
  'changes status',
  () => client.getChanges(INDEX),
  status => status.enabled ?? status,
)
await attempt('changes on', () => client.updateChanges(INDEX, { enabled: true }))

await attempt('suggestions on', () => client.updateQuerySuggestions(INDEX, { enabled: true, fields: ['title'] }))
await attempt(
  'suggestions status',
  () => client.querySuggestionsStatus(INDEX),
  status => status.enabled ?? null,
)
await attempt('record query', () => client.recordQuery(INDEX, 'zorblat'))
await attempt('build suggestions', async () => finished(await client.buildQuerySuggestions(INDEX)), taskShape)
await attempt('preview suggestions', () => client.previewQuerySuggestions(INDEX, 5))
await attempt('replace bans', () => client.replaceQueryBans(INDEX, ['brondo']))
await attempt('read bans', () => client.readQueryBans(INDEX))
await attempt('remove query', () => client.removeQuery(INDEX, 'zorblat'))
await attempt(
  'manual suggestion',
  () => client.addManualSuggestion(INDEX, { group: 'all', query: 'mavrik quindle' }),
  id => typeof id,
)

await attempt(
  'list tasks',
  () => client.listTasks({ limit: 100 }),
  page => page.tasks.map(task => `${task.type}:${task.status}`).sort(),
)
await attempt(
  'get missing task',
  () => client.getTask('00000000-0000-4000-8000-000000000000'),
  task => task ?? null,
)
await attempt('cancel missing task', () => client.cancelTask('00000000-0000-4000-8000-000000000000'))

await attempt('close', () => client.close(INDEX))
await attempt('search closed', () => client.query(INDEX, { term: 'zorblat' }), scored)
await attempt('open', () => client.open(INDEX))
await attempt('clear', () => client.clear(INDEX))
const cleared = await attempt('count cleared', () => client.countDocuments(INDEX))
assert.equal(cleared, 0, 'the cleared index holds no document')
for (const name of [INDEX, COPY, IMPORTED, LOADED]) await attempt(`drop ${name}`, () => client.dropIndex(name))
await attempt('drop missing', () => client.dropIndex('never-created'))
await attempt(
  'list after drops',
  () => client.listIndexes(),
  list => list.map(entry => entry.name),
)

process.stdout.write(`${JSON.stringify(steps)}\n`)
