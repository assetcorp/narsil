import { readFile } from 'node:fs/promises'
import { createNarsil } from '@delali/narsil'

const [planPath, mode] = process.argv.slice(2)
const plan = JSON.parse(await readFile(planPath, 'utf8'))
const readsOnWorkers = mode === 'workers'
const SETTLE_TIMEOUT_MS = 90_000
const POLL_MS = 10
const LAST_SCHEDULER_HOP_MS = 0

function handlesWithHarnessPipesOpen() {
  process.stdout.write('')
  process.stderr.write('')
  return process.getActiveResourcesInfo()
}

const handlesBeforeEngine = handlesWithHarnessPipesOpen()
let copiedAtEnd = false
let finished = false
const engine = await createNarsil({
  workers: readsOnWorkers
    ? { enabled: true, count: 1, promotionThreshold: plan.copyThreshold, mainCopyQueries: 'lone' }
    : { enabled: false },
})

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition, label) {
  const started = Date.now()
  while (!(await condition())) {
    if (Date.now() - started > SETTLE_TIMEOUT_MS) throw new Error(`Timed out waiting until ${label}`)
    await pause(POLL_MS)
  }
}

const graphSettled = () =>
  engine
    .vectorMaintenanceStatus(plan.index)
    .every(field => !field.building && field.graphCount > 0 && field.bufferSize === 0)

const copiedToWorker = async () =>
  (await engine.getMemoryStats()).workerCopies.some(copy => copy.indexName === plan.index && copy.scaledOut)

let tick = 0
const writes = []
const queries = []

async function write(round, change) {
  const start = ++tick
  if (change.kind === 'remove') await engine.remove(plan.index, change.id)
  else if (change.kind === 'insert') await engine.insert(plan.index, { id: change.id, ...change.document })
  else await engine.update(plan.index, change.id, change.document)
  writes.push({ round, kind: change.kind, id: change.id, document: change.document, start, end: ++tick })
}

async function search(round, request) {
  const params = {
    mode: 'vector',
    limit: plan.limit,
    document: false,
    vector: { field: plan.field, value: request.vector, metric: 'euclidean' },
  }
  if (request.filtered) params.filters = { fields: { shelf: { lte: plan.highestFilteredShelf } } }
  const start = ++tick
  const result = await engine.query(plan.index, params)
  queries.push({
    round,
    vector: request.vector,
    filtered: request.filtered,
    start,
    end: ++tick,
    hits: result.hits.map(hit => ({ id: hit.id, score: hit.score ?? null })),
  })
}

try {
  await engine.createIndex(plan.index, plan.config)
  const loaded = await engine.insertBatch(plan.index, plan.initial)
  if (loaded.failed.length > 0) throw new Error('The first documents did not load')
  await until(graphSettled, 'the graph holds every vector')
  if (readsOnWorkers) await until(copiedToWorker, 'a worker holds a copy of the index')
  for (let round = 0; round < plan.rounds.length; round++) {
    const { changes, searches } = plan.rounds[round]
    const pending = []
    const steps = Math.max(changes.length, searches.length)
    for (let at = 0; at < steps; at++) {
      if (at < searches.length) pending.push(search(round, searches[at]))
      if (at < changes.length) pending.push(write(round, changes[at]))
    }
    await Promise.all(pending)
  }
  copiedAtEnd = readsOnWorkers ? await copiedToWorker() : false
  finished = true
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
} finally {
  await engine.shutdown()
}
await pause(LAST_SCHEDULER_HOP_MS)
if (finished) {
  const handlesLeft = process.getActiveResourcesInfo().filter(handle => !handlesBeforeEngine.includes(handle))
  process.stdout.write(`${JSON.stringify({ writes, queries, copiedAtEnd, handlesLeft })}\n`)
}
