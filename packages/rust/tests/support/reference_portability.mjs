import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, specPath] = process.argv.slice(2)
const { createNarsil } = await import(pathToFileURL(join(repositoryRoot, 'packages/ts/dist/index.mjs')).href)
const spec = JSON.parse(readFileSync(specPath, 'utf8'))

const MILLISECONDS_PER_SECOND = 1000
const NANOSECONDS_PER_MILLISECOND = 1000000

function failureOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
    return { error: { code: error.code, message: error.message } }
  }
  throw error
}

function taggedNumber(value) {
  if (Number.isFinite(value)) return value
  return { $number: Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity' }
}

function taggedDate(value) {
  const milliseconds = value.getTime()
  const seconds = Math.floor(milliseconds / MILLISECONDS_PER_SECOND)
  const nanoseconds = (milliseconds - seconds * MILLISECONDS_PER_SECOND) * NANOSECONDS_PER_MILLISECOND
  return { $date: [seconds, nanoseconds] }
}

function tagged(value) {
  if (typeof value === 'number') return taggedNumber(value)
  if (value instanceof Date) return taggedDate(value)
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') }
  if (Array.isArray(value)) return value.map(tagged)
  if (ArrayBuffer.isView(value)) return Array.from(value, tagged)
  if (value === null || typeof value !== 'object') return value
  const fields = {}
  for (const [key, field] of Object.entries(value)) fields[key] = tagged(field)
  const keys = Object.keys(fields)
  return keys.length === 1 && keys[0].startsWith('$') ? { $object: fields } : fields
}

async function heldDocuments(narsil, index, ids) {
  const held = await narsil.getMultiple(index, ids)
  const documents = {}
  for (const [id, document] of held) {
    const { id: _ignored, ...fields } = document
    documents[id] = tagged(fields)
  }
  return documents
}

async function bytesOf(stream) {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function readBoth(narsil) {
  const outcome = {}
  try {
    await narsil.restore('restored', readFileSync(spec.archive))
    outcome.archive = { documents: await heldDocuments(narsil, 'restored', spec.ids) }
  } catch (error) {
    outcome.archive = failureOf(error)
  }
  try {
    const result = await narsil.importDocumentExport('imported', readFileSync(spec.export))
    outcome.export = {
      imported: result.imported,
      refusedCount: result.refusedCount,
      documents: await heldDocuments(narsil, 'imported', spec.ids),
    }
  } catch (error) {
    outcome.export = failureOf(error)
  }
  return outcome
}

async function writeBoth(narsil) {
  await narsil.createIndex('written', spec.config)
  const result = await narsil.insertBatch('written', spec.documents)
  if (result.failed.length > 0) throw new Error(`the reference refused ${JSON.stringify(result.failed)}`)
  writeFileSync(spec.archive, await bytesOf(await narsil.snapshot('written')))
  writeFileSync(spec.export, await bytesOf(await narsil.exportDocuments('written')))
  return { written: spec.documents.length }
}

const narsil = await createNarsil({ workers: { enabled: false } })
try {
  const outcome = spec.mode === 'write' ? await writeBoth(narsil) : await readBoth(narsil)
  process.stdout.write(JSON.stringify(outcome))
} finally {
  await narsil.shutdown()
}
