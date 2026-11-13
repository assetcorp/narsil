import { mkdtemp, rm } from 'node:fs/promises'
import { freemem, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createNarsil } from '../../../../dist/index.mjs'
import { memoryThatNoFileBacks } from '../../runtime/process-memory-oracle.mjs'

const INDEX = 'notes'
const MARGIN_BYTES = 64 * 1024 * 1024
const MEASUREMENT_AGE_MS = 50
const [operation, storage] = process.argv.slice(2)
const directory = storage === 'durable' ? await mkdtemp(join(tmpdir(), 'narsil-callback-memory-')) : undefined
const before = memoryThatNoFileBacks()
const constrained = process.constrainedMemory()
const limit = constrained > 0 && constrained < totalmem() ? constrained : Math.min(totalmem(), before + freemem())
const blockWritesAbove = (before + MARGIN_BYTES) / limit
let armed = false
let ballast
let nestedCode

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

const engine = await createNarsil({
  workers: { enabled: false },
  durability: directory === undefined ? undefined : { directory },
  memory: { blockWritesAbove, resumeWritesBelow: blockWritesAbove / 2 },
  plugins: [{ name: 'nested-memory-pressure', beforeInsert: fillDuringWrite, beforeUpdate: fillDuringWrite }],
})
await engine.createIndex(INDEX, { schema: { body: 'string' } })
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
const hits = (await engine.query(INDEX, { term: 'note', limit: 10 })).hits.map(hit => hit.id).sort()
const original = await engine.get(INDEX, 'original')
await engine.shutdown()
let recoveredHits = hits
if (directory !== undefined) {
  try {
    const recovered = await createNarsil({
      workers: { enabled: false },
      durability: { directory },
      memory: { blockWritesAbove, resumeWritesBelow: blockWritesAbove / 2 },
    })
    recoveredHits = (await recovered.query(INDEX, { term: 'note', limit: 10 })).hits.map(hit => hit.id).sort()
    await recovered.shutdown()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
process.stdout.write(
  `RESULT ${JSON.stringify({ nestedCode, refusedCode, hits, recoveredHits, original, held: ballast?.length })}\n`,
)
