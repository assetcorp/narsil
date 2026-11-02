import { createNarsil } from '../../../../dist/index.mjs'

const FILLED_INDEX = 'catalogue'
const LATER_INDEX = 'ledger'
const BATCH_DOCUMENTS = 200
const WORDS_PER_DOCUMENT = 80
const MOST_BATCHES = 5_000
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

let state = 0x5eed
function random() {
  state = (state + 0x6d2b79f5) >>> 0
  let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
}

function inventedWord() {
  let word = 'zq'
  for (let letter = 0; letter < 7; letter++) word += LETTERS[Math.floor(random() * LETTERS.length)]
  return word
}

function batchFrom(firstSerial) {
  const documents = []
  for (let offset = 0; offset < BATCH_DOCUMENTS; offset++) {
    const words = []
    for (let word = 0; word < WORDS_PER_DOCUMENT; word++) words.push(inventedWord())
    documents.push({ id: `doc-${firstSerial + offset}`, body: words.join(' ') })
  }
  return documents
}

function describe(error) {
  return { code: error?.code ?? null, reason: error?.details?.reason ?? null, message: String(error?.message) }
}

const narsil = await createNarsil({
  workers: { enabled: false },
  memory: { blockWritesAbove: Number(process.env.BLOCK_ABOVE), resumeWritesBelow: Number(process.env.RESUME_BELOW) },
})
await narsil.createIndex(FILLED_INDEX, { schema: { body: 'string' }, language: 'english' })

let accepted = 0
let refusal = null
for (let batch = 0; batch < MOST_BATCHES && refusal === null; batch++) {
  try {
    const result = await narsil.insertBatch(FILLED_INDEX, batchFrom(accepted))
    accepted += result.succeeded.length
    if (result.failed.length > 0) refusal = describe(result.failed[0].error)
  } catch (error) {
    refusal = describe(error)
  }
}

let refusedSingle = null
try {
  await narsil.insert(FILLED_INDEX, { body: 'one more document' }, 'after-block')
} catch (error) {
  refusedSingle = describe(error)
}
const countWhileBlocked = await narsil.countDocuments(FILLED_INDEX)

await narsil.dropIndex(FILLED_INDEX)
await narsil.createIndex(LATER_INDEX, { schema: { body: 'string' }, language: 'english' })
let writeAfterDrop = null
try {
  await narsil.insert(LATER_INDEX, { body: 'quarterly ledger entry' }, 'ledger-1')
  writeAfterDrop = { accepted: true }
} catch (error) {
  writeAfterDrop = { accepted: false, ...describe(error) }
}
const laterHits = (await narsil.query(LATER_INDEX, { term: 'ledger' })).hits.map(hit => hit.id)
await narsil.shutdown()

process.stdout.write(
  `RESULT ${JSON.stringify({ accepted, refusal, refusedSingle, countWhileBlocked, writeAfterDrop, laterHits })}\n`,
)
