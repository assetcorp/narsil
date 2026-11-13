import { mkdtemp, rm } from 'node:fs/promises'
import { freemem, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createNarsil } from '../../../../dist/index.mjs'
import { memoryThatNoFileBacks } from '../../runtime/process-memory-oracle.mjs'

const INDEX = 'notes'
const MARGIN_BYTES = 64 * 1024 * 1024
const MEASUREMENT_AGE_MS = 50
const BATCH_DOCUMENTS = 2500
const BATCH_PREFIX = 'batch-'
const [operation, storage] = process.argv.slice(2)
const chunked = operation === 'insertBatchChunks' || operation === 'updateBatchChunks'
const directory = storage === 'durable' ? await mkdtemp(join(tmpdir(), 'narsil-callback-memory-')) : undefined
const before = memoryThatNoFileBacks()
const constrained = process.constrainedMemory()
const limit = constrained > 0 && constrained < totalmem() ? constrained : Math.min(totalmem(), before + freemem())
const blockWritesAbove = (before + MARGIN_BYTES) / limit
const memory = { blockWritesAbove, resumeWritesBelow: blockWritesAbove / 2 }
let armed = false
let ballast
let nestedCode
let preparedBatchDocuments = 0

async function fillDuringWrite() {
  if (!armed) return
  armed = false
  await engine.insert(INDEX, { body: 'nested accepted note' }, 'nested')
  ballast = Buffer.alloc(3 * MARGIN_BYTES, 1)
  await sleep(MEASUREMENT_AGE_MS)
  try {
    await engine.insert(INDEX, { body: 'nested refused note' }, 'refused')
  } catch (error) {
    nestedCode = error.code
  }
}

function countPrepared({ docId }) {
  if (armed && docId.startsWith(BATCH_PREFIX)) preparedBatchDocuments += 1
}

async function fillAfterFirstChunk() {
  if (!armed || ballast !== undefined) return
  ballast = Buffer.alloc(3 * MARGIN_BYTES, 1)
  await sleep(MEASUREMENT_AGE_MS)
}

const plugins = chunked
  ? [
      {
        name: 'chunked-memory-pressure',
        beforeInsert: countPrepared,
        beforeUpdate: countPrepared,
        afterInsert: fillAfterFirstChunk,
        afterUpdate: fillAfterFirstChunk,
      },
    ]
  : [{ name: 'nested-memory-pressure', beforeInsert: fillDuringWrite, beforeUpdate: fillDuringWrite }]

const engine = await createNarsil({
  workers: { enabled: false },
  durability: directory === undefined ? undefined : { directory },
  memory,
  plugins,
})
await engine.createIndex(INDEX, { schema: { body: 'string' } })

async function bodiesOf(reader, ids) {
  const bodies = {}
  for (const id of ids) {
    const body = (await reader.get(INDEX, id))?.body ?? 'absent'
    bodies[body] = (bodies[body] ?? 0) + 1
  }
  return bodies
}

async function reopened(read) {
  if (directory === undefined) return undefined
  try {
    const recovered = await createNarsil({ workers: { enabled: false }, durability: { directory }, memory })
    const answer = await read(recovered)
    await recovered.shutdown()
    return answer
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function runChunkedBatch() {
  const ids = Array.from({ length: BATCH_DOCUMENTS }, (_, at) => `${BATCH_PREFIX}${at}`)
  if (operation === 'updateBatchChunks') {
    await engine.insertBatch(
      INDEX,
      ids.map(id => ({ id, body: 'original note' })),
    )
  }
  armed = true
  const batch =
    operation === 'insertBatchChunks'
      ? await engine.insertBatch(
          INDEX,
          ids.map(id => ({ id, body: 'outer note' })),
        )
      : await engine.updateBatch(
          INDEX,
          ids.map(docId => ({ docId, document: { body: 'outer note' } })),
        )
  armed = false
  const stored = await bodiesOf(engine, ids)
  await engine.shutdown()
  const recovered = (await reopened(reader => bodiesOf(reader, ids))) ?? stored
  return {
    succeeded: batch.succeeded,
    failedIds: batch.failed.map(failure => failure.docId),
    failedCodes: [...new Set(batch.failed.map(failure => failure.error.code))],
    preparedBatchDocuments,
    stored,
    recovered,
    held: ballast?.length,
  }
}

async function runNestedWrite() {
  await engine.insert(INDEX, { body: 'original note' }, 'original')
  armed = true
  let refusedCode
  let batch
  try {
    if (operation === 'insert') await engine.insert(INDEX, { body: 'outer note' }, 'outer')
    if (operation === 'update') await engine.update(INDEX, 'original', { body: 'outer note' })
    if (operation === 'insertBatch') batch = await engine.insertBatch(INDEX, [{ id: 'outer', body: 'outer note' }])
    if (operation === 'updateBatch') {
      batch = await engine.updateBatch(INDEX, [{ docId: 'original', document: { body: 'outer note' } }])
    }
    if (batch !== undefined) refusedCode = batch.failed[0]?.error.code
  } catch (error) {
    refusedCode = error.code
  }
  const hitsOf = async reader => (await reader.query(INDEX, { term: 'note', limit: 10 })).hits.map(hit => hit.id).sort()
  const hits = await hitsOf(engine)
  const original = await engine.get(INDEX, 'original')
  await engine.shutdown()
  const recoveredHits = (await reopened(hitsOf)) ?? hits
  return { nestedCode, refusedCode, hits, recoveredHits, original, held: ballast?.length }
}

const result = chunked ? await runChunkedBatch() : await runNestedWrite()
process.stdout.write(`RESULT ${JSON.stringify(result)}\n`)
