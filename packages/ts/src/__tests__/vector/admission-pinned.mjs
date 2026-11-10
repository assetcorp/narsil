import { readFile } from 'node:fs/promises'
import { createNarsil } from '@delali/narsil'

const scenario = JSON.parse(await readFile(process.argv[2], 'utf8'))
const SETTLE_TIMEOUT_MS = 90_000
const POLL_MS = 10
const LAST_SCHEDULER_HOP_MS = 0
const MICROTASKS_BEFORE_GIVING_UP = 100_000

function handlesWithHarnessPipesOpen() {
  process.stdout.write('')
  process.stderr.write('')
  return process.getActiveResourcesInfo()
}

const handlesBeforeEngine = handlesWithHarnessPipesOpen()
const engine = await createNarsil({ workers: { enabled: false } })
let answer = null
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition, label) {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > SETTLE_TIMEOUT_MS) throw new Error(`Timed out waiting until ${label}`)
    await pause(POLL_MS)
  }
}

async function writesWhileHeld(params) {
  const order = []
  const searching = engine.query(scenario.index, params).then(answer => {
    order.push('query')
    return answer
  })
  let writing
  for (let at = 0; at < MICROTASKS_BEFORE_GIVING_UP && writing === undefined; at++) {
    if (engine.getStats(scenario.index).heldSearchStates > 0) {
      writing = Promise.all([
        engine.remove(scenario.index, scenario.removedId),
        engine.update(scenario.index, scenario.updatedId, scenario.updatedDocument),
        engine.insert(scenario.index, scenario.arrival),
      ]).then(() => order.push('writes'))
    }
    await Promise.resolve()
  }
  const answer = await searching
  if (writing !== undefined) await writing
  await engine.insertBatch(scenario.index, [scenario.removedDocument])
  await engine.update(scenario.index, scenario.updatedId, scenario.updatedOriginal)
  await engine.remove(scenario.index, scenario.arrival.id)
  return {
    writeStartedDuringSearch: writing !== undefined,
    order,
    hits: answer.hits.map(hit => ({
      id: hit.id,
      score: hit.score ?? null,
      embedding: hit.document?.embedding === undefined ? null : Array.from(hit.document.embedding),
    })),
  }
}

try {
  await engine.createIndex(scenario.index, scenario.config)
  const loaded = await engine.insertBatch(scenario.index, scenario.documents)
  if (loaded.failed.length > 0) throw new Error('The documents did not load')
  await until(
    () =>
      engine
        .vectorMaintenanceStatus(scenario.index)
        .every(field => !field.building && field.graphCount > 0 && field.bufferSize === 0),
    'the graph holds every vector',
  )
  const vector = await writesWhileHeld({
    mode: 'vector',
    limit: scenario.limit,
    vector: { field: 'embedding', value: scenario.query, metric: 'euclidean', efSearch: scenario.efSearch },
  })
  const hybrid = await writesWhileHeld({
    mode: 'hybrid',
    term: scenario.term,
    limit: scenario.limit,
    vector: { field: 'embedding', value: scenario.query, metric: 'euclidean', efSearch: scenario.efSearch },
  })
  answer = { vector, hybrid }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
} finally {
  await engine.shutdown()
}
await pause(LAST_SCHEDULER_HOP_MS)
if (answer !== null) {
  const handlesLeft = process.getActiveResourcesInfo().filter(handle => !handlesBeforeEngine.includes(handle))
  process.stdout.write(`${JSON.stringify({ ...answer, handlesLeft })}\n`)
}
