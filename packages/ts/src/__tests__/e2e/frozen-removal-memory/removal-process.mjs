import { open, readFile, writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { getHeapStatistics } from 'node:v8'

const INSERT_CHUNK_DOCUMENTS = 2_000
const RESIDENT_FILL_CHUNK_BYTES = 8 * 1024 * 1024
const HEAP_FILL_OBJECTS = 2_000

const job = JSON.parse(await readFile(process.argv[2], 'utf8'))
const { createNarsil } = await import(new URL('../../../../dist/index.mjs', import.meta.url).href)
await import(job.bootstrapModule)

const engineConfig = { durability: { directory: job.directory }, workers: { enabled: false } }
const writer = await createNarsil(engineConfig)
await writer.createIndex(job.indexName, job.indexConfig)
for (let at = 0; at < job.documents.length; at += INSERT_CHUNK_DOCUMENTS) {
  const outcome = await writer.insertBatch(job.indexName, job.documents.slice(at, at + INSERT_CHUNK_DOCUMENTS))
  if (outcome.failed.length > 0) throw new Error(`insert failed: ${JSON.stringify(outcome.failed[0])}`)
}
await writer.checkpoint(job.indexName)
await writer.shutdown()

const engine = await createNarsil(engineConfig)
const loadedBytes = (await engine.getStats(job.indexName)).estimatedMemoryBytes

function processLimitBytes() {
  const constrained = process.constrainedMemory()
  return constrained > 0 && constrained < totalmem() ? constrained : null
}

let filler = []
function fillMemory() {
  if (job.fill.kind === 'heap') {
    const target = job.fill.fraction * job.fill.limitBytes
    while (getHeapStatistics().used_heap_size < target) {
      filler.push(Array.from({ length: HEAP_FILL_OBJECTS }, (_, at) => ({ at, label: `filler-${filler.length}` })))
    }
  }
  if (job.fill.kind === 'resident') {
    const limit = processLimitBytes()
    if (limit === null) throw new Error('the process reports no container memory limit')
    while (process.memoryUsage.rss() < job.fill.fraction * limit) {
      filler.push(new Uint8Array(RESIDENT_FILL_CHUNK_BYTES).fill(1))
    }
  }
}

async function releaseMemory() {
  filler = []
  for (let pass = 0; pass < 3; pass++) {
    globalThis.gc?.()
    await new Promise(resolve => setImmediate(resolve))
  }
}

async function writeAnswers(path) {
  const file = await open(path, 'w')
  try {
    await file.write('[')
    for (const [at, query] of job.queries.entries()) {
      const result = await engine.query(job.indexName, { ...query, limit: job.resultLimit })
      const answer = JSON.stringify(result.hits.map(hit => ({ id: hit.id, score: hit.score })))
      await file.write(at === 0 ? answer : `,${answer}`)
    }
    await file.write(']')
  } finally {
    await file.close()
  }
}

await writeAnswers(`${job.resultPath}.served`)
fillMemory()
const filledResidentBytes = process.memoryUsage.rss()
const filledHeapBytes = getHeapStatistics().used_heap_size
const phases = []
for (const [at, docIds] of job.removalBatches.entries()) {
  if (at === job.releaseFillBefore) await releaseMemory()
  const outcome = await engine.removeBatch(job.indexName, docIds)
  phases.push({
    failed: outcome.failed,
    estimatedMemoryBytes: (await engine.getStats(job.indexName)).estimatedMemoryBytes,
    residentBytes: process.memoryUsage.rss(),
  })
  await writeAnswers(`${job.resultPath}.phase-${at}`)
}
const counted = await engine.countDocuments(job.indexName)
await engine.shutdown()
await writeFile(
  job.resultPath,
  JSON.stringify({
    loadedBytes,
    filledResidentBytes,
    filledHeapBytes,
    processLimitBytes: processLimitBytes(),
    fillerChunks: filler.length,
    counted,
    phases,
  }),
)
