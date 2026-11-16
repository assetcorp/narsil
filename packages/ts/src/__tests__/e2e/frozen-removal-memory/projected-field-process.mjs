import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNarsil } from '../../../../dist/index.mjs'

const ARRAY_ENTRIES = 1_000_000
const MAX_RETAINED_HEAP_BYTES = 2 * 1024 * 1024
const COLLECTION_PASSES = 3
const directory = await mkdtemp(join(tmpdir(), 'narsil-projected-field-memory-'))
const config = { durability: { directory }, workers: { enabled: false } }
let engine = await createNarsil(config)

async function collectedHeapBytes() {
  for (let pass = 0; pass < COLLECTION_PASSES; pass++) {
    await new Promise(resolve => setImmediate(resolve))
    globalThis.gc()
  }
  return process.memoryUsage().heapUsed
}

async function readPayload() {
  const answer = await engine.query('records', { term: 'needle', document: { include: ['payload'] } })
  assert.equal(answer.hits.length, 1)
  const values = answer.hits[0].document.payload.values
  assert.equal(values.length, ARRAY_ENTRIES)
  assert.equal(values[0], 1)
  assert.equal(values[ARRAY_ENTRIES - 1], 1)
}

try {
  await engine.createIndex('records', { schema: { title: 'string' } })
  await engine.insert('records', { title: 'needle', payload: { values: Array(ARRAY_ENTRIES).fill(1) } }, 'record')
  await engine.checkpoint('records')
  await engine.shutdown()
  engine = await createNarsil(config)
  await engine.query('records', { term: 'needle', document: { include: ['title'] } })
  const before = await collectedHeapBytes()
  await readPayload()
  await engine.query('records', { term: 'needle', document: { include: ['absent'] } })
  const afterRead = await collectedHeapBytes()
  await engine.dropIndex('records')
  await engine.shutdown()
  engine = null
  const afterDrop = await collectedHeapBytes()
  assert.ok(afterRead - before < MAX_RETAINED_HEAP_BYTES, `Projected read retained ${afterRead - before} heap bytes`)
  assert.ok(afterDrop - before < MAX_RETAINED_HEAP_BYTES, `Dropped index retained ${afterDrop - before} heap bytes`)
} finally {
  await engine?.shutdown()
  await rm(directory, { recursive: true, force: true })
}
